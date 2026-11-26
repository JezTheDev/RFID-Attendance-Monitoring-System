// Flash storage (LittleFS) for the roster cache and the offline queue.
// Every rewrite goes to a .tmp file first, so a power cut never leaves a half-written file.
#pragma once
#include <LittleFS.h>
#include <ArduinoJson.h>
#include <vector>

static const char* ROSTER_FILE = "/roster.json";
static const char* ROSTER_TMP = "/roster.tmp";
static const char* QUEUE_FILE = "/queue.jsonl";
static const char* QUEUE_TMP = "/queue.tmp";
static const char* QUEUE_BAD = "/queue.bad";
static const int QUEUE_MAX = 500;
static const int QUEUE_WARN = 450;

struct QueuedScan {
  String scanId;
  String uid;
  long scannedAt;       // 0 = clock was not synced at tap time
  String timeQuality;   // "ntp" or "pending"
  uint32_t boot;
  uint32_t ms;
};

static bool replaceFile(const char* tmp, const char* dest) {
  if (LittleFS.exists(dest) && !LittleFS.remove(dest)) return false;
  return LittleFS.rename(tmp, dest);
}

// A leftover .tmp is complete only if the real file is gone (we delete the real file
// only after the .tmp is fully written). Otherwise the .tmp may be half-written.
static void recoverFile(const char* tmp, const char* dest) {
  if (!LittleFS.exists(tmp)) return;
  if (LittleFS.exists(dest)) LittleFS.remove(tmp);
  else LittleFS.rename(tmp, dest);
}

bool storageBegin() {
  if (!LittleFS.begin(false)) {
    Serial.println("LittleFS not formatted yet, formatting (first use)");
    if (!LittleFS.begin(true)) return false;
  }
  recoverFile(ROSTER_TMP, ROSTER_FILE);
  recoverFile(QUEUE_TMP, QUEUE_FILE);
  return true;
}

// ---------- roster ----------

bool saveRosterData(JsonVariantConst data) {
  File f = LittleFS.open(ROSTER_TMP, "w");
  if (!f) return false;
  size_t expected = measureJson(data);
  size_t written = serializeJson(data, f);
  f.close();
  if (written != expected) {
    LittleFS.remove(ROSTER_TMP);
    return false;
  }
  if (replaceFile(ROSTER_TMP, ROSTER_FILE)) return true;
  recoverFile(ROSTER_TMP, ROSTER_FILE);
  return false;
}

bool loadRosterDoc(JsonDocument& doc) {
  if (!LittleFS.exists(ROSTER_FILE)) return false;
  File f = LittleFS.open(ROSTER_FILE, "r");
  if (!f) return false;
  DeserializationError err = deserializeJson(doc, f);
  f.close();
  return !err;
}

// ---------- queue ----------

static String scanToLine(const QueuedScan& q) {
  JsonDocument d;
  d["id"] = q.scanId;
  d["uid"] = q.uid;
  d["t"] = q.scannedAt;
  d["q"] = q.timeQuality;
  d["b"] = q.boot;
  d["ms"] = q.ms;
  String line;
  serializeJson(d, line);
  return line;
}

static bool lineToScan(const String& line, QueuedScan& q) {
  JsonDocument d;
  if (deserializeJson(d, line)) return false;
  if (!d["id"].is<const char*>() || !d["uid"].is<const char*>()) return false;
  q.scanId = d["id"].as<String>();
  q.uid = d["uid"].as<String>();
  q.scannedAt = d["t"] | 0L;
  q.timeQuality = d["q"] | "ntp";
  q.boot = d["b"] | 0UL;
  q.ms = d["ms"] | 0UL;
  return true;
}

int queueCountLines() {
  File f = LittleFS.open(QUEUE_FILE, "r");
  if (!f) return 0;
  int n = 0;
  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() > 0) n++;
  }
  f.close();
  return n;
}

bool queueAppend(const QueuedScan& q) {
  String line = scanToLine(q);
  File f = LittleFS.open(QUEUE_FILE, "a");
  if (!f) return false;
  size_t written = f.print(line);
  written += f.print('\n');
  f.close();
  return written == line.length() + 1;
}

int queueReadBatch(std::vector<QueuedScan>& out, int maxCount) {
  out.clear();
  File f = LittleFS.open(QUEUE_FILE, "r");
  if (!f) return 0;
  while (f.available() && (int)out.size() < maxCount) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;
    QueuedScan q;
    if (lineToScan(line, q)) out.push_back(q);
  }
  f.close();
  return (int)out.size();
}

// Removes confirmed scans. Unreadable lines (e.g. cut by a power loss) are moved to
// /queue.bad for manual checking instead of being deleted. Returns the new count, or -1.
int queueRemove(const std::vector<String>& confirmedIds) {
  File src = LittleFS.open(QUEUE_FILE, "r");
  if (!src) return -1;
  File tmp = LittleFS.open(QUEUE_TMP, "w");
  if (!tmp) { src.close(); return -1; }
  int kept = 0;
  bool ok = true;
  while (src.available()) {
    String line = src.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;
    QueuedScan q;
    if (!lineToScan(line, q)) {
      File bad = LittleFS.open(QUEUE_BAD, "a");
      if (bad) { bad.println(line); bad.close(); }
      Serial.println("Queue: unreadable line moved to /queue.bad");
      continue;
    }
    bool confirmed = false;
    for (const String& id : confirmedIds) {
      if (id == q.scanId) { confirmed = true; break; }
    }
    if (confirmed) continue;
    size_t w = tmp.print(line);
    w += tmp.print('\n');
    if (w != line.length() + 1) ok = false;
    kept++;
  }
  src.close();
  tmp.close();
  if (!ok) {
    LittleFS.remove(QUEUE_TMP);
    return -1;
  }
  if (!replaceFile(QUEUE_TMP, QUEUE_FILE)) {
    recoverFile(QUEUE_TMP, QUEUE_FILE);
    return -1;
  }
  return kept;
}
