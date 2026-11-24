// RFID Attendance — ESP32 firmware, Stage 1 (online)
// Implements docs/Device_API_Spec.md v0.2: device.submitScans + device.heartbeat.
// Stage 2 (next): LittleFS offline queue + device.getRoster.
//
// Libraries (Arduino IDE → Library Manager):
//   MFRC522 (GithubCommunity), LiquidCrystal_I2C, ArduinoJson (v7.x)
// Board: ESP32 Dev Module (ESP32 Arduino core 2.x or 3.x)

#include <SPI.h>
#include <MFRC522.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <time.h>
#include "driver/gpio.h"
#include "secrets.h"

#define FIRMWARE_VERSION "0.4.0"

// ================= PINS (validated: no conflicts) =================
#define SS_PIN 14
#define SCK_PIN 27
#define MOSI_PIN 23
#define MISO_PIN 19
#define RST_PIN 26

#define GREEN_LED 33    // accepted
#define RED_LED 32   // rejected / error (our board has no red LED)
#define BUZZER_PIN 25   // fixed on the PCB

// Wi-Fi power test: lower transmit power = smaller current bursts.
// Set to true only if the buzzer stays silent after Wi-Fi (power dip).
#define LOW_WIFI_POWER false

#define LCD_SDA 21
#define LCD_SCL 22

// Battery: voltage divider into GPIO34 (ADC1, safe with Wi-Fi).
// Set to true only when the divider is wired. Until then no heartbeat
// is sent (we never send a made-up battery value).
#define HAS_BATTERY_SENSE false
#define BATTERY_PIN 34
#define DIVIDER_RATIO 2.0f   // (R1 + R2) / R2, e.g. 100k + 100k = 2.0

const unsigned long WIFI_RETRY_MS = 30000;
unsigned long lastWifiTryAt = 0;

void maintainWifi() {                 // non-blocking: returns immediately
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiTryAt < WIFI_RETRY_MS) return;
  lastWifiTryAt = millis();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

// ================= TIMING =================
const unsigned long HTTP_TIMEOUT_MS = 20000;        // spec v0.2: 20 s
const unsigned long RESULT_SHOW_MS = 3000;
const unsigned long UNREGISTERED_SHOW_MS = 10000;  // time to write the UID down
unsigned long currentShowMs = RESULT_SHOW_MS;
const unsigned long HEARTBEAT_EVERY_MS = 300000UL;  // 5 minutes
unsigned long duplicateWindowMs = 5UL * 60UL * 1000UL;  // 5 minutes

MFRC522 rfid(SS_PIN, RST_PIN);
LiquidCrystal_I2C lcd(0x27, 16, 2);
Preferences prefs;

uint32_t bootCount = 0;
uint32_t scanSequence = 0;

unsigned long lastResultAt = 0;
bool showingResult = false;
unsigned long lastHeartbeatAt = 0;

String lastUid = "";
unsigned long lastUidAt = 0;

// ================= SMALL HELPERS =================

void allIndicatorsOff() {
  digitalWrite(GREEN_LED, LOW);
  digitalWrite(RED_LED, LOW);
  digitalWrite(BUZZER_PIN, LOW);
}

// GPIO25 shares hardware with the Wi-Fi/analog (ADC2/DAC) block.
// Starting Wi-Fi can change the pin's internal routing, so we put the
// pin back into plain digital-output mode right before every beep.
void beep(int ms) {
  gpio_reset_pin((gpio_num_t)BUZZER_PIN);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, HIGH);
  delay(ms);
  digitalWrite(BUZZER_PIN, LOW);
}

void lcdShow(const String& line1, const String& line2) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(line1.substring(0, 16));
  lcd.setCursor(0, 1);
  lcd.print(line2.substring(0, 16));
}

void showReady() {
  allIndicatorsOff();
  lcdShow("Tap your ID", WiFi.status() == WL_CONNECTED ? "Online" : "No Wi-Fi");
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

// ================= FEEDBACK (spec 8.2) =================

void feedbackAccepted(const String& name) {
  allIndicatorsOff();
  lcdShow("Recorded", name);
  digitalWrite(GREEN_LED, HIGH);
  beep(150);
}

void feedbackDuplicate(const String& line1, const String& line2) {
  allIndicatorsOff();
  lcdShow(line1, line2);
  beep(120); delay(120); beep(120);
}

void feedbackRejected(const String& line1, const String& line2) {
  allIndicatorsOff();
  lcdShow(line1, line2);
  digitalWrite(RED_LED, HIGH);
  beep(700);
}

void feedbackDeviceError() {
  allIndicatorsOff();
  lcdShow("Device error", "Contact admin");
  digitalWrite(RED_LED, HIGH);
  beep(100); delay(100); beep(100); delay(100); beep(100);
}

// ================= WI-FI + TIME =================

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  lcdShow("Connecting", "Wi-Fi...");
  WiFi.mode(WIFI_STA);
  if (LOW_WIFI_POWER) WiFi.setTxPower(WIFI_POWER_8_5dBm);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(250);
  }
  Serial.println(WiFi.status() == WL_CONNECTED ? "Wi-Fi connected" : "Wi-Fi FAILED");
}

void syncTime() {
  // Epoch time in UTC; the server converts to Asia/Manila.
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  lcdShow("Syncing time", "...");
  unsigned long start = millis();
  while (!timeIsSynced() && millis() - start < 15000) {
    delay(250);
  }
  Serial.println(timeIsSynced() ? "Time synced" : "Time sync FAILED");
}

// ================= HTTP (spec 3.1: POST, then GET the 302 Location) =================
// Returns true only if we got a JSON body back. body = that JSON text.

bool postJson(const String& payload, String& body) {
  if (WiFi.status() != WL_CONNECTED) return false;

  String location = "";
  int code = 0;
  {
    WiFiClientSecure client;
    client.setInsecure();  // Stage 1. TODO: Google root CA (spec 3.2)
    HTTPClient http;
    http.setTimeout(HTTP_TIMEOUT_MS);
    http.setConnectTimeout(HTTP_TIMEOUT_MS);
    http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
    if (!http.begin(client, API_URL)) {
      Serial.println("DEBUG http.begin failed (check API_URL)");
      return false;
    }
    const char* headerKeys[] = {"Location"};
    http.collectHeaders(headerKeys, 1);
    http.addHeader("Content-Type", "application/json");
    code = http.POST(payload);
    Serial.printf("DEBUG POST HTTP %d\n", code);
    if (code == 200) {
      body = http.getString();
      http.end();
      Serial.println("DEBUG body: " + body.substring(0, 200));
      return body.length() > 0;
    }
    if (code == 301 || code == 302 || code == 303 || code == 307) {
      location = http.header("Location");
      if (location.length() == 0) location = http.getLocation();
    } else if (code < 0) {
      Serial.println("DEBUG error: " + http.errorToString(code));
    }
    http.end();
  }

  if (location.length() == 0) {
    Serial.printf("POST failed, HTTP %d (no redirect Location)\n", code);
    return false;
  }
  Serial.println("DEBUG redirect to: " + location.substring(0, 60) + "...");

  // New client for the new host (script.googleusercontent.com)
  WiFiClientSecure client2;
  client2.setInsecure();
  HTTPClient http2;
  http2.setTimeout(HTTP_TIMEOUT_MS);
  http2.setConnectTimeout(HTTP_TIMEOUT_MS);
  if (!http2.begin(client2, location)) return false;
  int code2 = http2.GET();
  Serial.printf("DEBUG GET HTTP %d\n", code2);
  if (code2 == 200) body = http2.getString();
  else if (code2 < 0) Serial.println("DEBUG error: " + http2.errorToString(code2));
  http2.end();
  if (code2 == 200) Serial.println("DEBUG body: " + body.substring(0, 200));
  return code2 == 200 && body.length() > 0;
}

// ================= device.submitScans (one live scan) =================

void submitLiveScan(const String& uid) {
  String scanId = nextScanId();
  long scannedAt = (long)time(nullptr);

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

  lcdShow("Processing...", "");
  unsigned long t0 = millis();
  String body;
  bool gotReply = postJson(payload, body);
  Serial.printf("scan %s took %lu ms\n", scanId.c_str(), millis() - t0);

  if (!gotReply) {
    // Stage 1: no offline queue yet, so the scan is NOT saved.
    feedbackRejected("Not saved", "Tap again later");
    return;
  }

  JsonDocument res;
  if (deserializeJson(res, body)) {
    Serial.println("Reply is not JSON");
    feedbackRejected("Not saved", "Tap again later");
    return;
  }

  if (!res["ok"].as<bool>()) {
    String code = res["error"]["code"] | "SERVER_ERROR";
    Serial.println("Request error: " + code);
    if (code == "INVALID_DEVICE_KEY" || code == "DEVICE_DISABLED" || code == "DEVICE_NOT_ASSIGNED") {
      feedbackDeviceError();
    } else {
      feedbackRejected("Server busy", "Tap again");
    }
    return;
  }

  JsonObject r = res["data"]["results"][0];
  String result = r["result"] | "";
  String name = r["lcd_line2"] | "";
  if (result == "ALREADY_RECORDED") result = r["original_result"] | "";
  Serial.println("Result: " + result);

  if (result == "ACCEPTED") {
    feedbackAccepted(name);
    lastUid = uid; lastUidAt = millis();
  } else if (result == "DUPLICATE") {
    feedbackDuplicate("Already recorded", name);
    lastUid = uid; lastUidAt = millis();
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
    feedbackRejected("Not saved", "Tap again later");
  }
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
  req["queue_count"] = 0;
  req["time_synced"] = timeIsSynced();
  req["firmware_version"] = FIRMWARE_VERSION;
  req["uptime_seconds"] = (long)(millis() / 1000);
  String payload;
  serializeJson(req, payload);
  String body;
  bool ok = postJson(payload, body);
  if (ok) Serial.println(String("Heartbeat sent: ") + body);
  else Serial.println("Heartbeat failed");
}

// ================= SETUP =================

void setup() {
  Serial.begin(115200);

  pinMode(GREEN_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  allIndicatorsOff();

  Wire.begin(LCD_SDA, LCD_SCL);
  lcd.init();
  lcd.backlight();

  SPI.begin(SCK_PIN, MISO_PIN, MOSI_PIN, SS_PIN);
  rfid.PCD_Init();
  rfid.PCD_DumpVersionToSerial();

  if (HAS_BATTERY_SENSE) analogSetPinAttenuation(BATTERY_PIN, ADC_11db);

  // boot_count survives restarts (spec 5.3)
  prefs.begin("rfid", false);
  bootCount = prefs.getUInt("boot", 0) + 1;
  prefs.putUInt("boot", bootCount);
  Serial.printf("Boot count: %lu\n", (unsigned long)bootCount);

  lcdShow("RFID Attendance", "Starting...");
  digitalWrite(RED_LED, HIGH);
  connectWifi();
  syncTime();
  allIndicatorsOff();

  sendHeartbeat();
  lastHeartbeatAt = millis();
  showReady();
  Serial.println("SYSTEM READY");
}

// ================= MAIN LOOP =================

void loop() {
  if (showingResult && millis() - lastResultAt > currentShowMs) {
    showingResult = false;
    showReady();
  }

  maintainWifi();

  if (millis() - lastHeartbeatAt > HEARTBEAT_EVERY_MS) {
    lastHeartbeatAt = millis();
    sendHeartbeat();
  }

  if (!rfid.PICC_IsNewCardPresent()) return;
  if (!rfid.PICC_ReadCardSerial()) return;

  String uid = uidToString(rfid.uid);
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  Serial.println("\nCard UID: " + uid);

  currentShowMs = RESULT_SHOW_MS;   // default; unregistered sets it longer

  if (uid == lastUid && millis() - lastUidAt < duplicateWindowMs) {
    // Local cooldown (spec 7): not sent, not counted
    feedbackDuplicate("Already scanned", "Please wait");
  } else if (WiFi.status() != WL_CONNECTED) {
    feedbackRejected("No Wi-Fi", "Tap again later");
  } else if (!timeIsSynced()) {
    syncTime();
    feedbackRejected("Clock not ready", "Tap again");
  } else {
    submitLiveScan(uid);
  }

  lastResultAt = millis();
  showingResult = true;
}