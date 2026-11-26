// Offline decisions: pure C++ (no Arduino calls) so it can be tested on a PC.
// The server computes the tap windows; this file only compares numbers.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

struct CardEntry {
  std::string uid;
  std::string name;
};

struct TapWindow {
  long start;
  long end;
  bool cancelled;
  std::vector<std::string> uids;
};

struct RosterCache {
  bool loaded = false;
  std::string version;
  long validUntil = 0;
  std::vector<CardEntry> cards;
  std::vector<TapWindow> windows;

  const CardEntry* findCard(const std::string& uid) const {
    for (const CardEntry& c : cards) {
      if (c.uid == uid) return &c;
    }
    return nullptr;
  }
};

enum OfflineVerdict { V_UNREGISTERED, V_NO_CLASS, V_CANCELLED, V_NOT_ENROLLED, V_QUEUE };

// No cache yet (first boot offline): queue everything, the server decides later.
// No clock or expired cache: queue any registered card.
inline OfflineVerdict decideOffline(const RosterCache& cache, const std::string& uid,
                                    long now, bool timeKnown) {
  if (!cache.loaded) return V_QUEUE;
  if (cache.findCard(uid) == nullptr) return V_UNREGISTERED;
  if (!timeKnown || now > cache.validUntil) return V_QUEUE;

  bool anyWindow = false;
  bool anyActive = false;
  for (const TapWindow& w : cache.windows) {
    if (now < w.start || now > w.end) continue;
    anyWindow = true;
    if (w.cancelled) continue;
    anyActive = true;
    for (const std::string& u : w.uids) {
      if (u == uid) return V_QUEUE;
    }
  }
  if (!anyWindow) return V_NO_CLASS;
  if (!anyActive) return V_CANCELLED;
  return V_NOT_ENROLLED;
}

// Local "Already scanned" memory. Unsigned math keeps it correct when millis() rolls over.
struct RecentTaps {
  static const int SLOTS = 64;
  std::string uid[SLOTS];
  uint32_t at[SLOTS] = {0};
  bool used[SLOTS] = {false};

  bool seen(const std::string& u, uint32_t nowMs, uint32_t windowMs) const {
    for (int i = 0; i < SLOTS; i++) {
      if (used[i] && uid[i] == u && (uint32_t)(nowMs - at[i]) < windowMs) return true;
    }
    return false;
  }

  void remember(const std::string& u, uint32_t nowMs) {
    int slot = -1;
    for (int i = 0; i < SLOTS; i++) {
      if (used[i] && uid[i] == u) { slot = i; break; }
    }
    if (slot < 0) {
      for (int i = 0; i < SLOTS; i++) {
        if (!used[i]) { slot = i; break; }
      }
    }
    if (slot < 0) {
      uint32_t oldestAge = 0;
      for (int i = 0; i < SLOTS; i++) {
        uint32_t age = nowMs - at[i];
        if (slot < 0 || age > oldestAge) { slot = i; oldestAge = age; }
      }
    }
    uid[slot] = u;
    at[slot] = nowMs;
    used[slot] = true;
  }
};

// Time of a tap made before the clock was synced (same power cycle only).
inline long backfillTime(long nowEpoch, uint32_t nowMs, uint32_t scanMs) {
  return nowEpoch - (long)((uint32_t)(nowMs - scanMs) / 1000u);
}
