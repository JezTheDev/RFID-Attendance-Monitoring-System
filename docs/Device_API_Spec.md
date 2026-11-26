# Device API Specification (ESP32 ↔ Server)
## IoT-Based RFID Attendance Monitoring System

| | |
|---|---|
| For | ESP32 firmware programmer (Velasco, Jezreel B.) |
| Version | 0.3 — November 27, 2026 (Section 6.3 `device.getRoster` v2) |
| Status | **Server API implemented and live-tested on 2026-11-20 (all 78 test requests passed).** This document describes what the deployed server actually does. The Web App URL is shared privately (never in GitHub) |
| Parent document | `RFID_Attendance_System_Architecture.md` (Sections 4 and 6) |

Tags used: **[P]** original proposal requirement · **[S]** approved software expansion · **[D]** team decision · **[R]** recommendation (needs agreement) · **[?]** open item for the hardware team

---

## Changes from v0.2

Only `device.getRoster` changed (Section 6.3). Firmware v0.4.1 never calls it, so nothing on the device now breaks.

| # | Topic | v0.2 | v0.3 |
|---|---|---|---|
| 1 | `roster_version` from getRoster | Integer, same as heartbeat / submitScans | **String** (16 hex characters), a hash of `settings` + `cards` + `windows`. Send it back as `known_version` |
| 2 | Tap windows | Not sent | New `windows`: every tap window in this device's room for the next 48 hours, with the enrolled UIDs |
| 3 | Settings | `heartbeat_interval_seconds` | `roster_refresh_seconds` (same admin setting): how often to call getRoster |
| 4 | Lifetime | — | New `generated_at`, `valid_until` (= `generated_at` + 48 h) |
| 5 | Request | `known_version` only | Optional `firmware_version`, `queue_count`; stored on the device row with `last_seen_at`. getRoster now takes the write lock for that one row |

## Changes from v0.1

If you already wrote code against v0.1, check these first.

| # | Topic | v0.1 said | v0.2 (what the server does) |
|---|---|---|---|
| 1 | LATE status | `attendance_status` is `PRESENT` or `LATE` | **No LATE.** An `ACCEPTED` tap is always `PRESENT` [D]. The "Recorded - Late" LCD row is removed |
| 2 | Tap window | Not defined | From **15 minutes before** the scheduled start **until the scheduled end** [D] (Section 8.2) |
| 3 | `RETRY_LATER` | Result with `final: false` | **Never returned.** Every scan result has `final: true`. Server problems fail the whole request (`SERVER_BUSY`, `SERVER_ERROR`) instead |
| 4 | `ALREADY_RECORDED` | "Contains the original result" | New field **`original_result`** (e.g. `"ACCEPTED"`) |
| 5 | `lcd_line2` | "May be empty" | Filled **only** for `ACCEPTED` and `DUPLICATE` (and for `ALREADY_RECORDED` when the original was one of those). Empty `""` for every other result |
| 6 | `scan_id` | Format recommended | **Enforced.** Must be `<your device_id>-NNNNNN-NNNNNN`. Another device's id → `BAD_REQUEST` |
| 7 | Bad input | Not defined | **Any** bad field or bad scan item → `BAD_REQUEST` for the **whole** request; nothing is saved (Section 6.4) |
| 8 | UID length | "7-byte UIDs → 14 hex" | Must be **8, 14 or 20** hex characters (4, 7 or 10 bytes) |
| 9 | `device_key` | "32+ random characters" | Exactly **64 hex characters** |
| 10 | `server_time` | ISO 8601 | Always Manila time with **`+08:00`**, in **every** reply, errors included |
| 11 | Heartbeat fields | Listed only | All six fields are **required** and range-checked (Section 6.2). `sent_at` is not used by heartbeat |
| 12 | `INVALID_TIME` | "far outside reasonable range" | Only when `time_quality` is `unverified`, `scanned_at` is `0`, or `scanned_at` is **more than 5 minutes ahead** of the server clock. Old scans are **not** rejected for being old |
| 13 | Error codes | — | New: `UNKNOWN_ACTION`. `BAD_REQUEST` also for a body that is not JSON and for missing `device_id`/`device_key` |
| 14 | Timeout | ~15 s | **20 s**, based on measured times (Section 3.2) |
| 15 | Device feedback | Recommended | **Option A decided** [D]: wait for the server result and show `Processing...` meanwhile |
| 16 | Roster | Active cards | Active cards **of active students** only. `changed: false` reply also has `server_time` |
| 17 | `firmware_version` in submitScans | Listed in the example | Optional. If sent, the server stores it on the device row |

---

## 1. What changed from the proposal (quick summary)

| Proposal [P] | Now [S] | What it means for firmware |
|---|---|---|
| Scan = daily attendance | Scan belongs to a **class session** | Firmware does **not** need to know schedules. Send UID + time; the server decides which class |
| One device | **One device per room**, shared by many classes | Firmware is the same for every room; only `device_id` and `device_key` differ |
| Upload record to Google Sheets | Upload to an Apps Script API with **device authentication** | Every request includes `device_id` + `device_key` |
| Offline buffer, remove after confirmation | Same, plus a **unique `scan_id`** per scan | Prevents duplicate rows when a retry happens |
| Feedback: accepted / duplicate / unregistered | Same three, plus new results (not enrolled, no class now, cancelled, saved offline) | Mostly new **LCD text** (Section 8) |

Hardware is unchanged. No new components are required by this spec.

---

## 2. Division of work

| ESP32 does | Server does |
|---|---|
| Read UID, convert to hex text | Verify device key |
| NTP time sync, timestamp each tap | Find the room of the device |
| Local double-tap cooldown (default 5 min) [P] | Find the class session from schedule + time |
| Generate `scan_id` | Check card is active, student is active and enrolled |
| Upload, or queue in LittleFS if it fails [P] | Prevent duplicates (per `scan_id` and per session) |
| Show LED/buzzer/LCD result [P] | Store attendance (always `PRESENT`) and a log row for every scan |
| Report battery, Wi-Fi, queue size [P] | Return one result per scan |

---

## 3. Transport

| Item | Value |
|---|---|
| URL | One Apps Script Web App URL ending in `/exec` (shared privately). Keep it in the secrets file, not in GitHub |
| Method | `POST` |
| Protocol | HTTPS (`WiFiClientSecure` + `HTTPClient`) |
| Header | `Content-Type: application/json` |
| Body | JSON with an `action` field (Section 6) |
| Timeout | **20 s** (Section 3.2) |
| HTTP status | Apps Script replies **200** even for errors. **Always read the JSON `ok` field.** Never treat "HTTP 200" alone as success |

Tip: opening the URL in a browser (a GET) shows `{"ok":true,...,"data":{"service":"RFID Attendance API","status":"running"}}`. Use it to check that the URL is right.

### 3.1 Redirect handling (important)

Apps Script processes the POST, then answers **HTTP 302** with a `Location` header. The actual JSON result is at that Location and must be fetched with **GET**. (The live test used exactly this: POST without following redirects, then GET the `Location`.)

Known pitfalls:
- `HTTPC_FORCE_FOLLOW_REDIRECTS` re-sends the **POST** with the same body to the new URL. The redirect host has no POST handler, so this fails (reported as HTTP 405).
- Reusing one `WiFiClientSecure` across the host change (`script.google.com` → `script.googleusercontent.com`) can break the TLS session on ESP32.

Procedure:
1. `http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS)` and `http.collectHeaders(...)` for `Location`.
2. `POST` the body.
3. If the code is **302**: read `Location`, call `http.end()`, then make a **new** client and send a plain **GET** to that URL. Its body is the JSON response.
4. If the code is **200**: the body is already the JSON response.
5. Anything else, a timeout, a failed GET, or a body that is not valid JSON → **treat as failed** and keep the scan in the queue.

Why it's safe to retry: the POST may already have been saved even if step 3 fails. When the device retries, the server finds the same `scan_id` and returns `ALREADY_RECORDED` instead of creating a second row.

### 3.2 How long a request takes (measured)

Measured on the live Web App on 2026-11-20 (POST + redirect GET together):

| Situation | Time per request |
|---|---|
| Normal | **~2.3 – 3.7 s** (median ~3 s) |
| 10 requests arriving at the same time | up to **~13 s** |

So:
- Set the HTTP timeout to **20 s**.
- Show `Processing...` on the LCD while waiting (Section 7).
- Writes (`submitScans`, `heartbeat`) take turns on the server. A write waits **up to 10 s** for its turn; if the server is still busy, it answers `SERVER_BUSY`, normally before your 20 s timeout fires. A timeout can still happen (slow network). **Treat a timeout and `SERVER_BUSY` the same way:** keep the scan in the queue and retry later.

### 3.3 TLS certificate [?]
Validating Google's root CA is preferred over `setInsecure()`. If root-CA validation causes problems on your board, tell the software side so we document the trade-off.

---

## 4. Device authentication

Every request includes:

| Field | Type | Example | Notes |
|---|---|---|---|
| `device_id` | string | `DEV-RM301-01` | Format `DEV-<room code>-NN`. Created by the admin; never changes |
| `device_key` | string | 64 hex characters | Generated by the admin, **shown once**. The server stores only a hash |

Rules:
- Store both in a secrets file that is in `.gitignore` (e.g. `secrets.h`). **Never commit them.**
- Generating a new key in the Admin portal **replaces the old key immediately**. The old key stops working at once.
- A new device starts in `maintenance`. The admin must set a key, assign a room and set it `active` before it can send anything.
- Order of checks (the first failing one is returned):
  1. `device_id` or `device_key` missing/empty → `BAD_REQUEST`
  2. Unknown device **or** wrong key → `INVALID_DEVICE_KEY` (same error for both, on purpose)
  3. Device not `active` (`maintenance` or `retired`) → `DEVICE_DISABLED`
  4. Device has no room → `DEVICE_NOT_ASSIGNED`
- On any of these, **keep all queued scans** and show "Device error" (Section 6.4).
- Student and instructor logins are **never** used on the device.

---

## 5. Time, UIDs, and scan IDs

### 5.1 Time [P]
- Sync with NTP at boot and periodically (e.g., every 1–6 hours).
- Send all times as **Unix epoch seconds (UTC)**, as **whole numbers** (no decimals). The server converts to Asia/Manila.
- Every server response includes `server_time`, e.g. `"2026-11-20T08:05:13+08:00"` (Manila time). If the device clock differs by more than ~2 minutes, re-sync NTP [R].
- A `scanned_at` more than **5 minutes ahead** of the server clock is rejected as `INVALID_TIME`.

`time_quality` values:

| Value | When |
|---|---|
| `ntp` | Clock was synced when the card was tapped |
| `backfilled` | Tap happened **before** NTP sync in the same power cycle; time was calculated after sync as `now − (millis_now − millis_at_scan)` |
| `unverified` | No NTP sync ever happened before power was lost. Send `scanned_at: 0`. The server logs it as `INVALID_TIME` for manual review |

No RTC module is in the component list, so `unverified` is a known limitation [?].

### 5.2 UID format
Uppercase hexadecimal, all UID bytes in reader order. Must be **8, 14 or 20** hex characters (4-, 7- or 10-byte UIDs).
Example: bytes `04 A1 B2 C3` → `"04A1B2C3"`.
The server also accepts lowercase and removes spaces, `:` and `-`, but please send the clean form.

### 5.3 `scan_id` (unique per tap)

```
scan_id = <device_id>-<boot_count:6 digits>-<sequence:6 digits>
example:  DEV-RM301-01-000042-000317
```

- **Enforced by the server:** it must start with **this device's own** `device_id` followed by `-`, then exactly 6 digits, `-`, 6 digits. Anything else → `BAD_REQUEST` for the whole request.
- `boot_count`: stored in NVS (`Preferences`, part of the ESP32 core), **incremented at every boot**.
- `sequence`: counter in RAM, starts at 1 each boot, increments per tap that gets a `scan_id`.
- Created **at tap time** and **never changed**, including when the scan is retried from the queue.
- Do **not** create a `scan_id` for taps blocked by the local cooldown (they are not sent).

---

## 6. Actions

All three actions use the same reply shape:

```json
{ "ok": true,  "server_time": "2026-11-20T08:05:13+08:00", "data": { ... } }
{ "ok": false, "server_time": "2026-11-20T08:05:13+08:00", "error": { "code": "BAD_REQUEST", "message": "..." } }
```

Every `ok: true` device reply also has `data.timing = { lock_ms, load_ms, run_ms, save_ms, total_ms }`: where the server spent its time (for measurement only). The firmware ignores it.

### 6.1 `device.submitScans` — send 1 to 20 scans

Used for both live scans (1 item) and queue sync (batch). One code path.

**Request**
```json
{
  "action": "device.submitScans",
  "device_id": "DEV-RM301-01",
  "device_key": "<secret>",
  "sent_at": 1795133112,
  "firmware_version": "0.3.0",
  "scans": [
    {
      "scan_id": "DEV-RM301-01-000042-000317",
      "rfid_uid": "04A1B2C3",
      "scanned_at": 1795133110,
      "time_quality": "ntp",
      "sync_mode": "live"
    }
  ]
}
```

| Field | Required | Rule (else `BAD_REQUEST`) |
|---|---|---|
| `sent_at` | Yes | Whole number ≥ 0. Current device time, or `0` if not synced |
| `firmware_version` | No | Text. If present and not blank, saved on the device row |
| `scans` | Yes | Array with **1 to 20** items, oldest first |
| `scans[].scan_id` | Yes | Section 5.3 |
| `scans[].rfid_uid` | Yes | Section 5.2 |
| `scans[].scanned_at` | Yes | Whole number ≥ 0 (`0` = unknown time → `INVALID_TIME`) |
| `scans[].time_quality` | Yes | `ntp`, `backfilled` or `unverified` |
| `scans[].sync_mode` | Yes | `live` = sent right after the tap; `offline` = sent from the queue |

If **one** item is bad, the whole request fails with `BAD_REQUEST` and **nothing** is saved. The `message` names the bad field, e.g. `scans[0].rfid_uid is missing or invalid.` Print it to Serial — it is a firmware bug.

**Response**
```json
{
  "ok": true,
  "server_time": "2026-11-20T08:05:13+08:00",
  "data": {
    "results": [
      {
        "scan_id": "DEV-RM301-01-000042-000317",
        "result": "ACCEPTED",
        "attendance_status": "PRESENT",
        "final": true,
        "lcd_line2": "J. Dela Cruz"
      }
    ],
    "roster_version": 12
  }
}
```

| Field | Meaning |
|---|---|
| `results` | One item **per scan**, in the **same order** as the request |
| `result` | Result code (Section 8.1) |
| `attendance_status` | `"PRESENT"` when `result` is `ACCEPTED`, otherwise `""` |
| `final` | Always `true` (see Section 7.1) |
| `lcd_line2` | Short name (first initial + last name, at most 16 characters) for `ACCEPTED` and `DUPLICATE`; `""` for all other results |
| `original_result` | Only on `ALREADY_RECORDED`: the result the server gave the first time |
| `roster_version` | Integer: goes up on card, student and settings changes. If it changed since your last reply, call `device.getRoster` (its own version is a different string, Section 6.3) |

`ALREADY_RECORDED` example (the same `scan_id` was sent again after a lost reply):
```json
{
  "scan_id": "DEV-RM301-01-000042-000317",
  "result": "ALREADY_RECORDED",
  "attendance_status": "PRESENT",
  "final": true,
  "lcd_line2": "J. Dela Cruz",
  "original_result": "ACCEPTED"
}
```
(`attendance_status` and `lcd_line2` follow the **original** result.)

Notes:
- Scans in one batch are processed oldest first, and each one sees the ones before it. Two taps by the same student in the same batch → the second is `DUPLICATE`.
- Every new scan (accepted or not) is saved as one log row on the server, so the admin can review it.

### 6.2 `device.heartbeat` — status report (every 5 minutes)

The interval comes from the roster settings (`heartbeat_interval_seconds`, default 300).

**Request**
```json
{
  "action": "device.heartbeat",
  "device_id": "DEV-RM301-01",
  "device_key": "<secret>",
  "battery_voltage": 3.82,
  "wifi_rssi": -61,
  "queue_count": 0,
  "time_synced": true,
  "firmware_version": "0.3.0",
  "uptime_seconds": 5400
}
```

All six fields are **required**. Any missing or invalid one → `BAD_REQUEST` (the message names the field).

| Field | Type | Allowed |
|---|---|---|
| `battery_voltage` | number | 0 to 6 (volts). The **actual** battery voltage after the voltage-divider conversion [P]. The server rounds it to 2 decimals |
| `wifi_rssi` | whole number | −127 to 0 (dBm) |
| `queue_count` | whole number | ≥ 0 (scans waiting in the offline queue) |
| `time_synced` | boolean | `true` / `false` (not `"true"` text) |
| `firmware_version` | text | 1 to 32 characters (spaces at the ends are trimmed) |
| `uptime_seconds` | whole number | ≥ 0 |

(`sent_at` may be included, but heartbeat ignores it.)

**Response**
```json
{
  "ok": true,
  "server_time": "2026-11-20T08:05:13+08:00",
  "data": { "roster_version": 12, "low_battery": false }
}
```

- `low_battery` is `true` when the rounded voltage is **below** the admin setting `low_battery_voltage` (default 3.5 V).
- The low-battery alert itself is shown on the **dashboard** [P]. Showing it on the LCD too is optional [?].
- If `roster_version` changed since your last reply, call `device.getRoster` (Section 6.3; do not compare it with the getRoster string).

### 6.3 `device.getRoster` — offline cache: cards + room schedule (v0.3)

The device saves this in flash and uses it **only when it cannot reach the server** (offline, or a live upload failed) to show one of: `Unregistered` / `No class now` / `Class cancelled` / `Not enrolled` / `Saved offline`. The server stays the final authority: every queued scan still goes through `device.submitScans` later, and its result is the real one.

**Request**
```json
{
  "action": "device.getRoster",
  "device_id": "DEV-RM301-01",
  "device_key": "<secret>",
  "known_version": "3f9a0c1d2b4e5f60",
  "firmware_version": "0.5.0",
  "queue_count": 0
}
```

| Field | Required | Meaning |
|---|---|---|
| `known_version` | yes (may be `""`) | The `roster_version` string of the roster you have saved; `""` on first boot |
| `firmware_version` | no | 1–32 characters; stored on the device row |
| `queue_count` | no | Integer ≥ 0 (scans waiting in your queue); stored on the device row |

A bad `firmware_version` / `queue_count` is ignored (not an error). Every call also sets the device's `last_seen_at`.

**Response (changed)**
```json
{
  "ok": true,
  "server_time": "2026-11-23T08:10:00+08:00",
  "data": {
    "changed": true,
    "roster_version": "3f9a0c1d2b4e5f60",
    "generated_at": 1795392600,
    "valid_until": 1795565400,
    "settings": { "duplicate_window_minutes": 5, "roster_refresh_seconds": 300 },
    "cards": [
      { "uid": "4A485C83", "name": "J. Dela Cruz" }
    ],
    "windows": [
      { "start": 1795391100, "end": 1795399200, "label": "TEST 101 - 3C", "cancelled": false, "uids": ["4A485C83"] }
    ]
  }
}
```

**Response (not changed)** — when `known_version` equals the current version:
```json
{ "ok": true, "server_time": "2026-11-23T08:10:00+08:00", "data": { "changed": false, "roster_version": "3f9a0c1d2b4e5f60" } }
```
Keep your saved roster as it is.

| Field | Meaning |
|---|---|
| `roster_version` | String. Changes whenever `settings`, `cards` or `windows` change (card assigned/revoked, student status or name, schedule, enrollment, cancellation, settings, or a window entering/leaving the 48-hour range). Not affected by `generated_at` |
| `generated_at`, `valid_until` | Epoch seconds (UTC). `valid_until` = `generated_at` + 48 h. After `valid_until` the cache no longer covers "now": treat every tap as `Saved offline` (queue it) instead of guessing |
| `settings.duplicate_window_minutes` | Local double-tap cooldown (Section 7) |
| `settings.roster_refresh_seconds` | How often to call getRoster (admin setting `heartbeat_interval_seconds`) |
| `cards` | **All active cards of active students** (revoked/lost cards and inactive students are left out). `name` ≤ 16 characters |
| `windows` | Every tap window in **this device's room** that overlaps [now, now + 48 h], sorted by `start`. Back-to-back classes give overlapping windows |
| `windows[].start` | Epoch seconds: scheduled start − `early_window_minutes` (default 15) |
| `windows[].end` | Epoch seconds: scheduled end (+ `accept_after_end_minutes`, default 0). The server counts the whole end minute, so a tap with `end ≤ t < end + 60` is still inside |
| `windows[].label` | Class label, ≤ 16 characters |
| `windows[].cancelled` | `true` = the session was cancelled (show `Class cancelled`, do not queue as attendance) |
| `windows[].uids` | Active card UIDs of the students enrolled in that class |

Offline decision on the device (suggested): UID not in `cards` → `Unregistered`; no window with `start ≤ t ≤ end` → `No class now`; only cancelled windows → `Class cancelled`; UID not in any matching window's `uids` → `Not enrolled`; otherwise → `Saved offline` (queue it).

- The heartbeat / submitScans `roster_version` is a **different value** (an integer that only goes up for card, student and settings changes). Do **not** compare it with this string. Call getRoster at boot, every `roster_refresh_seconds`, and when that integer changes.
- Save to LittleFS (e.g., `/roster.json`); replace the old file only after the new one is fully written.
- Errors: same as every device action (Section 6.4): `INVALID_DEVICE_KEY`, `DEVICE_DISABLED`, `DEVICE_NOT_ASSIGNED`, `BAD_REQUEST`, `SERVER_BUSY`.

### 6.4 Request-level errors (`ok: false`)

```json
{ "ok": false, "server_time": "2026-11-20T08:05:13+08:00", "error": { "code": "INVALID_DEVICE_KEY", "message": "Unknown device or wrong device key." } }
```

When `ok` is `false`, **no** scan in that request was saved. There is no `results` list.

| Code | When | Device action |
|---|---|---|
| `INVALID_DEVICE_KEY` | Unknown `device_id` or wrong key | Keep queue; LCD "Device error"; retry slowly (every 5 min) |
| `DEVICE_DISABLED` | Device is `maintenance` or `retired` | Same as above |
| `DEVICE_NOT_ASSIGNED` | Device has no room | Same as above |
| `BAD_REQUEST` | Body is not JSON, `device_id`/`device_key` missing, or a field breaks a rule in Section 6 | Firmware bug — keep queue, print `message` to Serial |
| `UNKNOWN_ACTION` | `action` is not one of the three names in Section 6 (checked **after** the key) | Firmware bug — check spelling |
| `SERVER_BUSY` | Too many writes at the same time | Keep queue, retry with backoff |
| `SERVER_ERROR` | Unexpected server problem | Keep queue, retry with backoff |

---

## 7. Scan flow on the device

Device feedback **Option A** is decided [D]: when online, the device waits for the server result before showing the outcome, and shows `Processing...` meanwhile (usually ~3 s, Section 3.2).

```
Tap card
  │
  ├─ Same UID tapped within duplicate_window? ──Yes──► "Already scanned" feedback (not sent, not queued) [P]
  │
  ├─ Create scan_id + timestamp
  │
  ├─ Wi-Fi connected?
  │     ├─ Yes ─► LCD "Processing..." ─► submitScans (sync_mode: live)
  │     │           ├─ ok: true ─► show feedback for that result (Section 8)
  │     │           └─ ok: false / timeout / not JSON ─► append to queue ─► "Saved offline"
  │     │
  │     └─ No ──► UID in cached roster?
  │                 ├─ No  ─► "Unregistered" feedback (not queued) [P]
  │                 └─ Yes ─► append to queue (sync_mode: offline) ─► "Saved offline"
```

Notes:
- **Online, an unknown UID is still sent to the server** [R]. The cached roster may be outdated (e.g., a card registered 5 minutes ago), and the server logs unknown UIDs so the admin can register new cards by tapping them.
- The **local cooldown** only records the tap time after an `ACCEPTED`, `DUPLICATE`, or "Saved offline" outcome, not after rejections, so a student who got "No class now" can tap again later [R].
- `ok: false` with `INVALID_DEVICE_KEY` / `DEVICE_DISABLED` / `DEVICE_NOT_ASSIGNED` should show "Device error" instead of "Saved offline" (the scan is still queued).

### 7.1 Offline queue rules [P + R]

| Rule | Detail |
|---|---|
| Storage | LittleFS file, one JSON object per line (e.g., `/queue.jsonl`) [P] |
| Write first | If a live upload fails, the scan is appended **before** showing "Saved offline" |
| Upload order | Oldest first, batches of up to 20 |
| Removal | Remove a scan **only** after a reply with `ok: true` whose result for that `scan_id` has `"final": true` [P]. Today every result is final; keep the check anyway |
| `ok: false` | Remove **nothing** from the queue |
| Retry | Backoff: 10 s → 30 s → 60 s → 5 min (max) while Wi-Fi is up; retry immediately on Wi-Fi reconnect |
| New taps while syncing | Keep accepting taps; live taps may be sent immediately or queued behind — firmware's choice [?] |
| Capacity | Set a maximum (e.g., 500 scans) [?]. At ~90% show "Storage almost full". When full: **refuse new taps** with "Storage full" — never delete or overwrite old scans [R] |
| Feedback during sync | Results received while draining the queue are **not** shown on the LCD (the student already left). The server keeps them in its logs |
| Reporting | Send `queue_count` in every heartbeat |

---

## 8. Scan results and feedback

### 8.1 Result codes

The server checks a new scan in this order and returns the first match:

| # | `result` | Meaning | `lcd_line2` |
|---|---|---|---|
| 1 | `ALREADY_RECORDED` | Same `scan_id` was already processed (a retry). See `original_result` | from the original |
| 2 | `INVALID_TIME` | `time_quality` is `unverified`, `scanned_at` is `0`, or `scanned_at` is more than 5 min ahead of the server clock | `""` |
| 3 | `UNREGISTERED` | UID is not an **active** card of an **active** student | `""` |
| 4 | `NO_ACTIVE_SESSION` | No active term on that date, or no class in this room at that time | `""` |
| 5 | `SESSION_CANCELLED` | The class at that time was cancelled | `""` |
| 6 | `NOT_ENROLLED` | Valid student, but not enrolled in the class in this room now | `""` |
| 7 | `DUPLICATE` | Student already has attendance in this session | name |
| 8 | `ACCEPTED` | Saved. `attendance_status` is always `"PRESENT"` | name |

All results have `final: true` and are stored on the server, so removing them from the queue never loses information. (`RETRY_LATER` from v0.1 does not exist.)

### 8.2 When is a tap counted? [D]

- **Always `PRESENT`.** There is no LATE status on tap.
- **Tap window:** from **15 minutes before** the scheduled start **until the scheduled end** (the end minute itself counts: a class ending 10:00 accepts a tap at 10:00:59). Outside the window → `NO_ACTIVE_SESSION`.
- The window uses the **tap time** (`scanned_at`), not the upload time. An offline scan synced hours later is judged by when it was tapped.
- If two classes are back-to-back in the room and both windows match, the server picks the one the student is enrolled in.

(The 15 and 0 minutes are admin Settings `early_window_minutes` and `accept_after_end_minutes`. The firmware does not need them.)

### 8.3 Feedback table (to agree with the hardware team)

LCD is 16×2, so every line is 16 characters or fewer.

| Situation | LED | Buzzer | LCD line 1 | LCD line 2 | Tag |
|---|---|---|---|---|---|
| `ACCEPTED` | Green | 1 short | `Recorded` | name (`lcd_line2`) | [P] |
| `DUPLICATE` (server) | — | 2 short | `Already recorded` | name (`lcd_line2`) | [P] |
| Local cooldown | — | 2 short | `Already scanned` | `Please wait` | [P] |
| `UNREGISTERED` | Red | 1 long | `Unregistered` | `Card not found` | [P] |
| `NOT_ENROLLED` | Red | 1 long | `Not enrolled` | `in this class` | [R] |
| `NO_ACTIVE_SESSION` | Red | 1 long | `No class now` | `Scan not counted` | [R] |
| `SESSION_CANCELLED` | Red | 1 long | `Class cancelled` | `Scan not counted` | [R] |
| `INVALID_TIME` | Red | 1 long | `Clock error` | `Scan not counted` | [R] |
| Saved offline | Green [?] | 1 short [?] | `Saved offline` | `Will sync later` | [?] |
| Waiting for server | — | — | `Processing...` | — | [D] |
| Device/auth error | Red | 3 short | `Device error` | `Contact admin` | [R] |
| Queue full | Red | 1 long | `Storage full` | `Tell instructor` | [R] |
| Idle | — | — | `Tap your ID` | room or Wi-Fi status | [R] |

`ALREADY_RECORDED` normally happens only while draining the queue (no LCD). If it happens on a live tap, show the feedback for `original_result`.

Design rule for the new results: they reuse the proposal's **red + long beep** "rejected" pattern and differ only in LCD text, so no new hardware is needed [R].

Open question [?]: Should "Saved offline" use the same green + short beep as "Recorded"? The proposal flowchart shows green only after a confirmed upload. A saved-offline scan is safely stored but not yet confirmed, and the server may later reject it (e.g., not enrolled). Alternatives: green LED blink twice, or green with no beep.

---

## 9. Testing checklist for firmware

The server side of these was live-tested on 2026-11-20. Repeat them with the real device:

1. Registered card during a class → `ACCEPTED`, green + short beep, correct name.
2. Same card again within 5 min → local "Already scanned", nothing sent.
3. Same card after 5 min, same class → server `DUPLICATE`.
4. Unknown card while online → server `UNREGISTERED`, appears in the admin's unregistered-cards list.
5. Unknown card while offline → local "Unregistered", not queued.
6. Card of a student not in this class → `NOT_ENROLLED`.
7. Registered card with no class in the room → `NO_ACTIVE_SESSION`.
8. Wi-Fi off, tap 5 registered cards → 5 lines in queue, "Saved offline".
9. Wi-Fi on → queue drains, 5 records on the server, **no duplicates**.
10. Cut the connection **after** POST but before GET (simulate by stopping after step 2 of 3.1) → retry gives `ALREADY_RECORDED` with `original_result`, still one record.
11. Reboot with a non-empty queue → queue survives and syncs; `boot_count` increased, no `scan_id` collision.
12. Boot with no Wi-Fi, tap, then connect → `time_quality: backfilled` with a correct time.
13. Wrong `device_key` → "Device error", queue kept.
14. Heartbeat → dashboard shows battery voltage matching a multimeter reading [P].
15. `getRoster` twice → second call with the new `known_version` returns `changed: false`.
16. Measure tap-to-feedback delay (live) [P: Cloud Synchronization Delay test]. Expect ~3 s.

---

## 10. Open items for the hardware team [?]

| # | Item | Software side recommendation |
|---|---|---|
| H1 | Final LED/buzzer/LCD mapping (Section 8.3), especially "Saved offline" | Reuse existing patterns; differentiate by LCD |
| H2 | JSON parsing library on ESP32. The approved library list does not include one | **ArduinoJson** (free, widely used). Needs team approval since it is a new firmware dependency |
| H3 | Root-CA validation vs `setInsecure()` | Try root CA first |
| H4 | Queue capacity limit | Measure free LittleFS space; start with 500 |
| H5 | NTP re-sync interval | Every 1–6 hours + on clock drift |
| H6 | Unverified time when booting without Wi-Fi (no RTC) | Accept as a documented limitation for the MVP |
| H7 | Show low-battery warning on the LCD too, or dashboard only? | Dashboard required [P]; LCD optional |
