// RFID Attendance — ESP32 firmware v0.6.0 (Stage 2 offline mode + Stage 3 phone Wi-Fi setup)
// Spec: docs/Device_API_Spec.md v0.3 + Design_Stage2_Offline_Mode.md
//
// Libraries (Arduino IDE → Library Manager):
//   MFRC522 (GithubCommunity), LiquidCrystal_I2C, ArduinoJson (v7.x), WiFiManager (tzapu)
// Board: ESP32 Dev Module / ESP32-WROOM-DA
// Tools → Partition Scheme: "Default 4MB with spiffs" (the offline queue lives there)

#include <SPI.h>
#include <MFRC522.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WiFiManager.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <time.h>
#include "driver/gpio.h"
#include "secrets.h"
#include "offline_logic.h"
#include "storage.h"
#include "google_roots.h"

#ifndef SETUP_CARD_UID
#error "Add SETUP_CARD_UID and SETUP_AP_PASS to secrets.h (see secrets.example.h)"
#endif

#define FIRMWARE_VERSION "0.7.0"

// ================= PINS (validated: no conflicts) =================
#define SS_PIN 14
#define SCK_PIN 27
#define MOSI_PIN 23
#define MISO_PIN 19
#define RST_PIN 26

#define GREEN_LED 33    // accepted / already recorded / saved offline
#define RED_LED 32      // rejected / error
#define BUZZER_PIN 25   // fixed on the PCB

#define LOW_WIFI_POWER false
#define LED_SELF_TEST false

// Keep the HTTPS connections open between requests (faster taps).
// Measured 2026-11-27: Google closes the connection between taps, so it does not help.
#define REUSE_CONNECTIONS false

// Check that the server really is Google (root certificates in google_roots.h).
// Needs the clock: until NTP time is synced, requests fail and taps are saved offline.
#define VERIFY_TLS true

#define LCD_SDA 21
#define LCD_SCL 22

// Battery: voltage divider into GPIO34. No heartbeat until it is wired (no fake values).
#define HAS_BATTERY_SENSE false
#define BATTERY_PIN 34
#define DIVIDER_RATIO 2.0f

// ================= TIMING =================
const unsigned long WIFI_RETRY_MS = 30000;
const unsigned long HTTP_TIMEOUT_MS = 20000;
const unsigned long RESULT_SHOW_MS = 3000;
const unsigned long UNREGISTERED_SHOW_MS = 10000;
const unsigned long HEARTBEAT_EVERY_MS = 300000UL;
const unsigned long ROSTER_RETRY_MS = 60000UL;
const unsigned long BACKOFF_MS[] = {10000UL, 30000UL, 60000UL, 300000UL};
const int BACKOFF_STEPS = 4;
const int SYNC_BATCH = 20;
const unsigned long SETUP_MODE_MS = 300000UL;   // setup hotspot closes after 5 min

unsigned long duplicateWindowMs = 5UL * 60UL * 1000UL;   // updated from the server
unsigned long rosterRefreshMs = 300000UL;                // updated from the server
unsigned long currentShowMs = RESULT_SHOW_MS;

MFRC522 rfid(SS_PIN, RST_PIN);
LiquidCrystal_I2C lcd(0x27, 16, 2);
Preferences prefs;
WiFiClientSecure apiClient;    // script.google.com
WiFiClientSecure echoClient;   // script.googleusercontent.com (redirect target)
WiFiManager wifiSetup;

uint32_t bootCount = 0;
uint32_t scanSequence = 0;

RosterCache roster;
RecentTaps recentTaps;
int queueCount = 0;
bool deviceError = false;
bool setupMode = false;
unsigned long setupStartedAt = 0;

unsigned long lastWifiTryAt = 0;
bool wasOnline = false;
unsigned long lastResultAt = 0;
bool showingResult = false;
unsigned long lastHeartbeatAt = 0;
unsigned long lastRosterAt = 0;
bool rosterDue = true;
unsigned long lastSyncTryAt = 0;
unsigned long syncDelayMs = 0;
int backoffStep = 0;

// ================= SMALL HELPERS =================

// Wi-Fi can change the internal routing of some pins, so every output is put
// back into plain digital-output mode right before we drive it.
void setOutput(int pin, int level) {
  gpio_reset_pin((gpio_num_t)pin);
  pinMode(pin, OUTPUT);
  digitalWrite(pin, level);
}

void allIndicatorsOff() {
  setOutput(GREEN_LED, LOW);
  setOutput(RED_LED, LOW);
  setOutput(BUZZER_PIN, LOW);
}

void beep(int ms) {
  setOutput(BUZZER_PIN, HIGH);
  delay(ms);
  setOutput(BUZZER_PIN, LOW);
}

void lcdShow(const String& line1, const String& line2) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(line1.substring(0, 16));
  lcd.setCursor(0, 1);
  lcd.print(line2.substring(0, 16));
}

bool isOnline() {
  return WiFi.status() == WL_CONNECTED;
}

void showReady() {
  allIndicatorsOff();
  if (setupMode) {
    lcdShow("Setup: join WiFi", DEVICE_ID);
    return;
  }
  String line2;
  if (deviceError) line2 = "Device error";
  else if (queueCount >= QUEUE_WARN) line2 = "Storage 90% full";
  else if (queueCount > 0) line2 = "Saved:" + String(queueCount) + (isOnline() ? " Online" : " NoWiFi");
  else line2 = isOnline() ? "Online" : "No Wi-Fi";
  lcdShow("Tap your ID", line2);
}

// Spec 5.2: uppercase hex, no spaces or colons. Bytes 4A 48 5C 83 -> "4A485C83"
String uidToString(MFRC522::Uid& uid) {
  String s = "";
  for (byte i = 0; i < uid.size; i++) {
    if (uid.uidByte[i] < 0x10) s += "0";
    s += String(uid.uidByte[i], HEX);
  }
  s.toUpperCase();
  return s;
}

bool timeIsSynced() {
  return time(nullptr) > 1700000000;  // after Nov 2023
}

// Spec 5.3: <device_id>-<boot_count:6>-<sequence:6>
String nextScanId() {
  scanSequence++;
  char buf[64];
  snprintf(buf, sizeof(buf), "%s-%06lu-%06lu", DEVICE_ID,
           (unsigned long)bootCount, (unsigned long)scanSequence);
  return String(buf);
}

bool isDeviceAuthError(const String& code) {
  return code == "INVALID_DEVICE_KEY" || code == "DEVICE_DISABLED" || code == "DEVICE_NOT_ASSIGNED";
}

// ================= FEEDBACK (spec 8.2) =================

// Instant "your card was read" while we wait for the server (~4-5 s with Apps Script).
void feedbackCardRead() {
  allIndicatorsOff();
  lcdShow("Card read", "Please wait...");
  beep(30);
}

void feedbackAccepted(const String& name) {
  allIndicatorsOff();
  lcdShow("Recorded", name);
  setOutput(GREEN_LED, HIGH);
  beep(150);
}

void feedbackSavedOffline() {
  allIndicatorsOff();
  lcdShow("Saved offline", "Will sync later");
  setOutput(GREEN_LED, HIGH);
  beep(150);
}

void feedbackDuplicate(const String& line1, const String& line2) {
  allIndicatorsOff();
  lcdShow(line1, line2);
  setOutput(GREEN_LED, HIGH);
  beep(120); delay(120); beep(120);
}

void feedbackRejected(const String& line1, const String& line2) {
  allIndicatorsOff();
  lcdShow(line1, line2);
  setOutput(RED_LED, HIGH);
  beep(700);
}

// ================= WI-FI + TIME =================

void connectWifi() {
  lcdShow("Connecting", "Wi-Fi...");
  WiFi.mode(WIFI_STA);
  if (LOW_WIFI_POWER) WiFi.setTxPower(WIFI_POWER_8_5dBm);
  if (!prefs.getBool("wifi_init", false)) {
    // Very first boot: start from the network in secrets.h. After this, Wi-Fi is
    // managed from the phone, so an "Erase Wi-Fi" is not undone at the next boot.
    prefs.putBool("wifi_init", true);
    if (strlen(WIFI_SSID) > 0) WiFi.begin(WIFI_SSID, WIFI_PASS);
  } else if (wifiSetup.getWiFiIsSaved()) {
    WiFi.begin();
  } else {
    Serial.println("No saved Wi-Fi");
    return;
  }
  lastWifiTryAt = millis();
  unsigned long start = millis();
  while (!isOnline() && millis() - start < 15000) {
    delay(250);
  }
  if (isOnline()) Serial.printf("Wi-Fi connected, RSSI %d dBm\n", (int)WiFi.RSSI());
  else Serial.println("Wi-Fi FAILED (will keep retrying)");
}

void maintainWifi() {  // non-blocking
  if (setupMode || isOnline()) return;
  if (millis() - lastWifiTryAt < WIFI_RETRY_MS) return;
  lastWifiTryAt = millis();
  if (!wifiSetup.getWiFiIsSaved()) return;
  WiFi.disconnect();  // stop the auto-reconnect attempt first ("sta is connecting" error)
  WiFi.begin();       // the network saved from the phone
}

void startTimeSync() {
  configTime(0, 0, "pool.ntp.org", "time.google.com");  // UTC epoch; server converts to Manila
}

void waitForTime() {
  lcdShow("Syncing time", "...");
  unsigned long start = millis();
  while (!timeIsSynced() && millis() - start < 15000) {
    delay(250);
  }
  Serial.println(timeIsSynced() ? "Time synced" : "Time sync FAILED");
}

// ================= SETUP MODE (phone Wi-Fi setup) =================

void startSetupMode() {
  if (strlen(SETUP_AP_PASS) < 8) {
    Serial.println("SETUP_AP_PASS must be at least 8 characters");
    feedbackRejected("Setup password", "too short");
    return;
  }
  Serial.println("Setup mode ON");
  apiClient.stop();
  echoClient.stop();
  wifiSetup.setConfigPortalBlocking(false);
  wifiSetup.setConfigPortalTimeout(SETUP_MODE_MS / 1000);
  wifiSetup.setShowInfoErase(true);
  std::vector<const char*> menu = {"wifi", "info", "exit"};
  wifiSetup.setMenu(menu);
  wifiSetup.startConfigPortal(DEVICE_ID, SETUP_AP_PASS);
  setupMode = true;
  setupStartedAt = millis();
  allIndicatorsOff();
  lcdShow("Setup: join WiFi", DEVICE_ID);
  setOutput(GREEN_LED, HIGH);
  beep(80); delay(80); beep(80);
}

void endSetupMode(const char* reason) {
  Serial.printf("Setup mode OFF (%s)\n", reason);
  if (wifiSetup.getConfigPortalActive()) wifiSetup.stopConfigPortal();
  setupMode = false;
  WiFi.mode(WIFI_STA);
  if (!isOnline() && wifiSetup.getWiFiIsSaved()) WiFi.begin();
  lastWifiTryAt = millis();
}

// Taps keep working (offline) while the hotspot is open.
void serviceSetupMode() {
  if (!setupMode) return;
  if (wifiSetup.process()) {
    endSetupMode("new Wi-Fi saved");
    if (!showingResult) showReady();
  } else if (!wifiSetup.getConfigPortalActive() || millis() - setupStartedAt > SETUP_MODE_MS + 5000) {
    endSetupMode("closed");
    if (!showingResult) showReady();
  }
}

// ================= HTTP (spec 3.1: POST, then GET the 302 Location) =================

int httpOnce(bool isPost, const String& url, const String& payload, String& body, String& location) {
  WiFiClientSecure& client = isPost ? apiClient : echoClient;
  bool reused = client.connected();
  unsigned long t0 = millis();
  HTTPClient http;
  http.setReuse(REUSE_CONNECTIONS);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  if (!http.begin(client, url)) {
    Serial.println("DEBUG http.begin failed (check API_URL)");
    return -1000;
  }
  int code;
  if (isPost) {
    const char* headerKeys[] = {"Location"};
    http.collectHeaders(headerKeys, 1);
    http.addHeader("Content-Type", "application/json");
    code = http.POST(payload);
  } else {
    code = http.GET();
  }
  if (code == 200) {
    body = http.getString();
  } else if (code >= 300 && code < 400) {
    location = http.header("Location");
    if (location.length() == 0) location = http.getLocation();
    http.getString();  // read the small redirect page so the connection is clean for reuse
  } else if (code < 0) {
    Serial.println("DEBUG error: " + http.errorToString(code));
  }
  http.end();
  if (!REUSE_CONNECTIONS || code < 0) client.stop();
  Serial.printf("  %s %d in %lu ms (%s connection, kept open: %s)\n", isPost ? "POST" : "GET",
                code, millis() - t0, reused ? "reused" : "new", client.connected() ? "yes" : "no");
  return code;
}

// Returns true only if we got a JSON body back.
bool postJson(const String& payload, String& body) {
  if (!isOnline()) return false;
  body = "";
  String location = "";
  int code = httpOnce(true, String(API_URL), payload, body, location);
  if (code < 0 && REUSE_CONNECTIONS) {
    // The kept-open connection may have been closed by Google; retry once on a new one.
    // Safe: the server ignores a repeated scan_id (ALREADY_RECORDED).
    location = "";
    code = httpOnce(true, String(API_URL), payload, body, location);
  }
  if (code == 200) return body.length() > 0;
  if (location.length() == 0) {
    Serial.printf("POST failed, HTTP %d\n", code);
    return false;
  }
  String unused;
  int code2 = httpOnce(false, location, "", body, unused);
  if (code2 < 0 && REUSE_CONNECTIONS) {
    code2 = httpOnce(false, location, "", body, unused);
  }
  if (code2 != 200) Serial.printf("GET failed, HTTP %d\n", code2);
  return code2 == 200 && body.length() > 0;
}

void printServerTiming(JsonDocument& res) {
  if (res["data"]["timing"].is<JsonObject>()) {
    Serial.printf("  server_ms=%ld\n", (long)(res["data"]["timing"]["total_ms"] | 0L));
  }
}

// ================= ROSTER CACHE (device.getRoster v2) =================

void applySettings(JsonVariantConst settings) {
  if (!settings.is<JsonObjectConst>()) return;
  long dupMin = settings["duplicate_window_minutes"] | 0L;
  long refreshSec = settings["roster_refresh_seconds"] | 0L;
  if (dupMin > 0) duplicateWindowMs = (unsigned long)dupMin * 60000UL;
  if (refreshSec >= 60) rosterRefreshMs = (unsigned long)refreshSec * 1000UL;
}

bool parseRoster(JsonVariantConst data, RosterCache& out) {
  if (!data["cards"].is<JsonArrayConst>() || !data["windows"].is<JsonArrayConst>()) return false;
  RosterCache fresh;
  fresh.loaded = true;
  fresh.version = std::string((const char*)(data["roster_version"] | ""));
  fresh.validUntil = data["valid_until"] | 0L;
  for (JsonObjectConst card : data["cards"].as<JsonArrayConst>()) {
    CardEntry c;
    c.uid = std::string((const char*)(card["uid"] | ""));
    c.name = std::string((const char*)(card["name"] | ""));
    fresh.cards.push_back(c);
  }
  for (JsonObjectConst w : data["windows"].as<JsonArrayConst>()) {
    TapWindow t;
    t.start = w["start"] | 0L;
    t.end = w["end"] | 0L;
    t.cancelled = w["cancelled"] | false;
    for (JsonVariantConst u : w["uids"].as<JsonArrayConst>()) {
      t.uids.push_back(std::string((const char*)(u | "")));
    }
    fresh.windows.push_back(t);
  }
  out = fresh;
  return true;
}

void loadRosterFromFlash() {
  JsonDocument doc;
  if (!loadRosterDoc(doc)) {
    Serial.println("Roster: none saved yet");
    return;
  }
  if (parseRoster(doc.as<JsonVariantConst>(), roster)) {
    applySettings(doc["settings"]);
    Serial.printf("Roster from flash: %u cards, %u windows\n",
                  (unsigned)roster.cards.size(), (unsigned)roster.windows.size());
  }
}

void refreshRoster() {
  lastRosterAt = millis();
  rosterDue = false;

  JsonDocument req;
  req["action"] = "device.getRoster";
  req["device_id"] = DEVICE_ID;
  req["device_key"] = DEVICE_KEY;
  req["known_version"] = roster.loaded ? roster.version.c_str() : "";
  req["firmware_version"] = FIRMWARE_VERSION;
  req["queue_count"] = queueCount;
  String payload;
  serializeJson(req, payload);

  unsigned long t0 = millis();
  String body;
  bool gotReply = postJson(payload, body);
  Serial.printf("getRoster took %lu ms\n", millis() - t0);

  JsonDocument res;
  if (!gotReply || deserializeJson(res, body)) {
    Serial.println("getRoster failed, retry in 60 s");
    lastRosterAt = millis() - rosterRefreshMs + ROSTER_RETRY_MS;
    return;
  }
  printServerTiming(res);
  if (!(res["ok"] | false)) {
    String code = res["error"]["code"] | "SERVER_ERROR";
    Serial.println("getRoster error: " + code);
    if (isDeviceAuthError(code)) deviceError = true;
    lastRosterAt = millis() - rosterRefreshMs + ROSTER_RETRY_MS;
    return;
  }
  deviceError = false;

  JsonVariantConst data = res["data"];
  if (!(data["changed"] | false)) {
    Serial.println("Roster unchanged");
    return;
  }
  RosterCache fresh;
  if (!parseRoster(data, fresh)) {
    Serial.println("Roster reply missing cards/windows");
    return;
  }
  roster = fresh;
  applySettings(data["settings"]);
  bool saved = saveRosterData(data);
  Serial.printf("Roster updated: %u cards, %u windows%s\n",
                (unsigned)roster.cards.size(), (unsigned)roster.windows.size(),
                saved ? "" : " (NOT saved to flash)");
}

// ================= OFFLINE TAP =================

void offlineTap(const String& scanId, const String& uid, long now, bool timeKnown, uint32_t tapMs) {
  OfflineVerdict verdict = decideOffline(roster, std::string(uid.c_str()), now, timeKnown);
  Serial.printf("Offline decision: %d\n", (int)verdict);

  switch (verdict) {
    case V_UNREGISTERED:
      feedbackRejected("Unregistered", uid);
      currentShowMs = UNREGISTERED_SHOW_MS;
      return;
    case V_NO_CLASS:
      feedbackRejected("No class now", "Scan not counted");
      return;
    case V_CANCELLED:
      feedbackRejected("Class cancelled", "Scan not counted");
      return;
    case V_NOT_ENROLLED:
      feedbackRejected("Not enrolled", "in this class");
      return;
    case V_QUEUE:
      break;
  }

  if (queueCount >= QUEUE_MAX) {
    feedbackRejected("Storage full", "Tell instructor");
    return;
  }
  QueuedScan q;
  q.scanId = scanId;
  q.uid = uid;
  q.scannedAt = timeKnown ? now : 0;
  q.timeQuality = timeKnown ? "ntp" : "pending";
  q.boot = bootCount;
  q.ms = tapMs;
  if (!queueAppend(q)) {
    feedbackRejected("Not saved", "Storage error");
    return;
  }
  queueCount++;
  recentTaps.remember(std::string(uid.c_str()), millis());
  Serial.printf("Queued %s (queue %d)\n", scanId.c_str(), queueCount);
  feedbackSavedOffline();
}

// ================= LIVE TAP (device.submitScans, 1 scan) =================
// Returns true when the server gave a final answer (feedback already shown).
// Returns false when the tap must go through the offline decision instead.

bool submitLiveScan(const String& scanId, const String& uid, long scannedAt) {
  JsonDocument req;
  req["action"] = "device.submitScans";
  req["device_id"] = DEVICE_ID;
  req["device_key"] = DEVICE_KEY;
  req["sent_at"] = scannedAt;
  req["firmware_version"] = FIRMWARE_VERSION;
  JsonArray scans = req["scans"].to<JsonArray>();
  JsonObject s = scans.add<JsonObject>();
  s["scan_id"] = scanId;
  s["rfid_uid"] = uid;
  s["scanned_at"] = scannedAt;
  s["time_quality"] = "ntp";
  s["sync_mode"] = "live";

  String payload;
  serializeJson(req, payload);

  feedbackCardRead();
  unsigned long t0 = millis();
  String body;
  bool gotReply = postJson(payload, body);
  Serial.printf("scan %s took %lu ms\n", scanId.c_str(), millis() - t0);

  JsonDocument res;
  if (!gotReply || deserializeJson(res, body)) {
    Serial.println("Live upload failed -> offline decision");
    return false;
  }
  printServerTiming(res);

  if (!(res["ok"] | false)) {
    String code = res["error"]["code"] | "SERVER_ERROR";
    Serial.println("Request error: " + code + " -> offline decision");
    if (isDeviceAuthError(code)) deviceError = true;
    return false;
  }
  deviceError = false;

  JsonObject r = res["data"]["results"][0];
  String result = r["result"] | "";
  bool isFinal = r["final"] | false;
  String name = r["lcd_line2"] | "";
  if (result == "ALREADY_RECORDED") result = r["original_result"] | "";
  Serial.println("Result: " + result);

  if (!isFinal) return false;  // RETRY_LATER: keep it in the queue

  if (result == "ACCEPTED") {
    feedbackAccepted(name);
    recentTaps.remember(std::string(uid.c_str()), millis());
  } else if (result == "DUPLICATE") {
    feedbackDuplicate("Already recorded", name);
    recentTaps.remember(std::string(uid.c_str()), millis());
  } else if (result == "UNREGISTERED") {
    feedbackRejected("Unregistered", uid);
    currentShowMs = UNREGISTERED_SHOW_MS;
  } else if (result == "NOT_ENROLLED") {
    feedbackRejected("Not enrolled", "in this class");
  } else if (result == "NO_ACTIVE_SESSION") {
    feedbackRejected("No class now", "Scan not counted");
  } else if (result == "SESSION_CANCELLED") {
    feedbackRejected("Class cancelled", "Scan not counted");
  } else if (result == "INVALID_TIME") {
    feedbackRejected("Clock error", "Scan not counted");
  } else {
    return false;
  }
  return true;
}

void handleTap(const String& uid) {
  String scanId = nextScanId();
  bool timeKnown = timeIsSynced();
  long now = timeKnown ? (long)time(nullptr) : 0;
  uint32_t tapMs = millis();

  if (!setupMode && isOnline() && timeKnown && submitLiveScan(scanId, uid, now)) return;
  offlineTap(scanId, uid, now, timeKnown, tapMs);
}

// ================= QUEUE UPLOAD =================

void scheduleRetry() {
  syncDelayMs = BACKOFF_MS[backoffStep];
  if (backoffStep < BACKOFF_STEPS - 1) backoffStep++;
  Serial.printf("Queue upload: next try in %lu s\n", syncDelayMs / 1000);
}

void syncQueue() {
  lastSyncTryAt = millis();
  std::vector<QueuedScan> batch;
  if (queueReadBatch(batch, SYNC_BATCH) == 0) {
    queueCount = queueCountLines();
    return;
  }

  JsonDocument req;
  req["action"] = "device.submitScans";
  req["device_id"] = DEVICE_ID;
  req["device_key"] = DEVICE_KEY;
  req["sent_at"] = (long)time(nullptr);
  req["firmware_version"] = FIRMWARE_VERSION;
  JsonArray scans = req["scans"].to<JsonArray>();
  for (const QueuedScan& q : batch) {
    long scannedAt = q.scannedAt;
    String quality = q.timeQuality;
    if (scannedAt == 0) {
      if (q.boot == bootCount) {
        scannedAt = backfillTime((long)time(nullptr), millis(), q.ms);
        quality = "backfilled";
      } else {
        quality = "unverified";  // server marks INVALID_TIME for manual review
      }
    }
    JsonObject s = scans.add<JsonObject>();
    s["scan_id"] = q.scanId;
    s["rfid_uid"] = q.uid;
    s["scanned_at"] = scannedAt;
    s["time_quality"] = quality;
    s["sync_mode"] = "offline";
  }
  String payload;
  serializeJson(req, payload);

  lcdShow("Syncing...", "Saved:" + String(queueCount));
  unsigned long t0 = millis();
  String body;
  bool gotReply = postJson(payload, body);
  Serial.printf("Queue upload of %u took %lu ms\n", (unsigned)batch.size(), millis() - t0);

  JsonDocument res;
  if (!gotReply || deserializeJson(res, body)) {
    scheduleRetry();
    showReady();
    return;
  }
  printServerTiming(res);
  if (!(res["ok"] | false)) {
    String code = res["error"]["code"] | "SERVER_ERROR";
    Serial.println("Queue upload error: " + code);
    if (isDeviceAuthError(code)) {
      deviceError = true;
      backoffStep = BACKOFF_STEPS - 1;  // device errors: retry every 5 min
    }
    scheduleRetry();
    showReady();
    return;
  }
  deviceError = false;

  std::vector<String> confirmed;
  for (JsonObject r : res["data"]["results"].as<JsonArray>()) {
    Serial.printf("  %s -> %s %s %s\n", (const char*)(r["scan_id"] | ""), (const char*)(r["result"] | ""),
                  (const char*)(r["attendance_status"] | ""), (const char*)(r["original_result"] | ""));
    if (r["final"] | false) confirmed.push_back(r["scan_id"].as<String>());
  }
  if (!confirmed.empty()) {
    int left = queueRemove(confirmed);
    queueCount = left >= 0 ? left : queueCountLines();
  }
  Serial.printf("Queue: %u confirmed, %d left\n", (unsigned)confirmed.size(), queueCount);

  if (confirmed.size() == batch.size()) {
    backoffStep = 0;
    syncDelayMs = 0;
  } else {
    scheduleRetry();
  }
  showReady();
}

// ================= device.heartbeat =================

float readBatteryVolts() {
  uint32_t sum = 0;
  for (int i = 0; i < 16; i++) sum += analogReadMilliVolts(BATTERY_PIN);
  return (sum / 16.0f) * DIVIDER_RATIO / 1000.0f;
}

void sendHeartbeat() {
  if (!HAS_BATTERY_SENSE) return;  // no fake battery values
  JsonDocument req;
  req["action"] = "device.heartbeat";
  req["device_id"] = DEVICE_ID;
  req["device_key"] = DEVICE_KEY;
  req["sent_at"] = (long)time(nullptr);
  req["battery_voltage"] = roundf(readBatteryVolts() * 100.0f) / 100.0f;
  req["wifi_rssi"] = (int)WiFi.RSSI();
  req["queue_count"] = queueCount;
  req["time_synced"] = timeIsSynced();
  req["firmware_version"] = FIRMWARE_VERSION;
  req["uptime_seconds"] = (long)(millis() / 1000);
  String payload;
  serializeJson(req, payload);
  String body;
  Serial.println(postJson(payload, body) ? "Heartbeat sent" : "Heartbeat failed");
}

// ================= BACKGROUND WORK (only while idle) =================
// One network call per loop pass, so a waiting card is read soon after.

void onWifiConnected() {
  Serial.printf("Wi-Fi back, RSSI %d dBm\n", (int)WiFi.RSSI());
  if (!timeIsSynced()) startTimeSync();
  apiClient.stop();
  echoClient.stop();
  rosterDue = true;
  backoffStep = 0;
  syncDelayMs = 0;
  showReady();
}

void backgroundWork() {
  if (!isOnline()) return;

  if (rosterDue || millis() - lastRosterAt >= rosterRefreshMs) {
    refreshRoster();
    showReady();
    return;
  }
  if (queueCount > 0 && timeIsSynced() && millis() - lastSyncTryAt >= syncDelayMs) {
    syncQueue();
    return;
  }
  if (HAS_BATTERY_SENSE && millis() - lastHeartbeatAt > HEARTBEAT_EVERY_MS) {
    lastHeartbeatAt = millis();
    sendHeartbeat();
  }
}

// ================= SETUP =================

void setup() {
  Serial.begin(115200);
  allIndicatorsOff();

  if (LED_SELF_TEST) {
    Serial.println("LED test: GREEN (GPIO33)");
    setOutput(GREEN_LED, HIGH); delay(1000); setOutput(GREEN_LED, LOW);
    Serial.println("LED test: RED (GPIO32)");
    setOutput(RED_LED, HIGH); delay(1000); setOutput(RED_LED, LOW);
  }

  Wire.begin(LCD_SDA, LCD_SCL);
  lcd.init();
  lcd.backlight();

  SPI.begin(SCK_PIN, MISO_PIN, MOSI_PIN, SS_PIN);
  rfid.PCD_Init();
  rfid.PCD_DumpVersionToSerial();

  if (HAS_BATTERY_SENSE) analogSetPinAttenuation(BATTERY_PIN, ADC_11db);

  prefs.begin("rfid", false);
  bootCount = prefs.getUInt("boot", 0) + 1;
  prefs.putUInt("boot", bootCount);
  Serial.printf("Firmware %s, boot count %lu\n", FIRMWARE_VERSION, (unsigned long)bootCount);

  lcdShow("RFID Attendance", "Starting...");
  if (storageBegin()) {
    loadRosterFromFlash();
    queueCount = queueCountLines();
    Serial.printf("Queue on flash: %d\n", queueCount);
  } else {
    Serial.println("STORAGE FAILED: check Tools -> Partition Scheme");
    lcdShow("Storage error", "Check partition");
    delay(3000);
  }

  if (VERIFY_TLS) {
    apiClient.setCACert(GOOGLE_ROOT_CAS);
    echoClient.setCACert(GOOGLE_ROOT_CAS);
  } else {
    apiClient.setInsecure();
    echoClient.setInsecure();
  }

  setOutput(RED_LED, HIGH);
  startTimeSync();
  connectWifi();
  if (isOnline()) waitForTime();
  allIndicatorsOff();

  if (LED_SELF_TEST) {
    Serial.println("LED test after Wi-Fi: GREEN (GPIO33)");
    setOutput(GREEN_LED, HIGH); delay(1000); setOutput(GREEN_LED, LOW);
  }

  wasOnline = isOnline();
  if (wasOnline) {
    lcdShow("Loading classes", "...");
    refreshRoster();  // also wakes up Apps Script before the first tap
  }
  lastHeartbeatAt = millis();
  if (!isOnline() && !wifiSetup.getWiFiIsSaved()) startSetupMode();  // new device: set Wi-Fi from a phone
  showReady();
  Serial.println("SYSTEM READY");
}

// ================= MAIN LOOP =================

void loop() {
  if (showingResult && millis() - lastResultAt > currentShowMs) {
    showingResult = false;
    showReady();
  }

  serviceSetupMode();
  maintainWifi();
  bool online = isOnline();
  if (online && !wasOnline) onWifiConnected();
  if (!online && wasOnline) {
    Serial.println("Wi-Fi lost");
    if (!showingResult) showReady();
  }
  wasOnline = online;

  if (!showingResult && !setupMode) backgroundWork();

  if (!rfid.PICC_IsNewCardPresent()) return;
  if (!rfid.PICC_ReadCardSerial()) return;

  String uid = uidToString(rfid.uid);
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  Serial.println("\nCard UID: " + uid);

  currentShowMs = RESULT_SHOW_MS;
  if (uid == SETUP_CARD_UID) {
    if (setupMode) {
      endSetupMode("admin card");
      allIndicatorsOff();
      lcdShow("Setup closed", "");
      beep(80);
    } else {
      startSetupMode();
    }
  } else if (recentTaps.seen(std::string(uid.c_str()), millis(), duplicateWindowMs)) {
    feedbackDuplicate("Already scanned", "Please wait");
  } else {
    handleTap(uid);
  }

  lastResultAt = millis();
  showingResult = true;
}