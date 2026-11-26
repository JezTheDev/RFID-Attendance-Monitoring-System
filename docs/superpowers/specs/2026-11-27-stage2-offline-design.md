# Stage 2 backend: device.getRoster v2 (offline room schedule cache)

Status: design approved by Dan (2026-11-27).

## Context

- Firmware v0.5.0 caches this response in ESP32 flash and uses it ONLY when
  offline (or when a live upload fails) to decide: Unregistered / No class now /
  Class cancelled / Not enrolled / Saved offline.
- The server stays the final authority: queued scans still go through
  `device.submitScans` later.
- Firmware v0.4.1 (on the device now) never calls getRoster, so changing its
  format is safe.

## A1: device.getRoster v2

Request:

```json
{ "action": "device.getRoster", "device_id": "...", "device_key": "...",
  "known_version": "<string or empty>", "firmware_version": "optional string", "queue_count": 0 }
```

Response (changed):

```json
{ "ok": true, "server_time": "...", "data": {
    "changed": true,
    "roster_version": "<string>",
    "generated_at": 1764000000, "valid_until": 1764172800,
    "settings": { "duplicate_window_minutes": 5, "roster_refresh_seconds": 300 },
    "cards": [ { "uid": "4A485C83", "name": "<=16 chars" } ],
    "windows": [ { "start": 1764000000, "end": 1764007200, "label": "TEST 101 - 3C", "cancelled": false, "uids": ["..."] } ] } }
```

Response (not changed, `known_version` == current): `{ ok:true, server_time, data:{ changed:false, roster_version } }`

Rules:

- `cards` = ALL active cards (revoked excluded), uid + short display name (<= 16 chars).
- `windows` = every tap window in THIS DEVICE'S assigned room overlapping
  [now, now+48h]. `start` = scheduled start - tap window minutes (15, the existing
  setting), `end` = scheduled end, epoch UTC seconds. Computed with the EXISTING
  session engine (day of week, term dates, cancellations, enrolled_at rule). No new
  rule logic; if the engine cannot give this without duplication, stop and ask.
- `uids` = active card UIDs of students enrolled in that class on that date.
- Cancelled sessions are included with `cancelled: true`.
- `roster_version` = hash of cards + windows + settings (NOT generated_at /
  valid_until), so it changes whenever any of that data changes. The integer
  `roster_version` may be kept only if it is guaranteed to change on every
  card/schedule/enrollment/cancellation change.
- Same device auth + error codes as the other device actions.
- `firmware_version` / `queue_count`: stored with the device's last-seen info
  ONLY if a column already exists. No schema change without asking.
- Speed: a typical call stays around 3 s or less; the computed payload may be
  cached (CacheService, TTL <= 5 min). Report the measured time.
- `docs/Device_API_Spec.md` section 6.3 updated to this contract (v0.3).

Tests cover: room filtering; start = start - 15 min; cancelled flag; enrolled_at;
revoked cards excluded; version changes when data changes and not otherwise;
changed:false path; bad key -> INVALID_DEVICE_KEY; back-to-back classes give two
overlapping windows.

## A2: measure only

Measure where time goes in one live `device.submitScans` (lock wait, reads,
writes) in the test env. Report numbers. Do NOT change submitScans speed without
approval.

## A3: ship

Full test suite passes -> rebuild Bundle.gs -> commit -> push main and
`git push origin main:backend-work`. Then say exactly what to paste into Apps
Script and to deploy a NEW VERSION (same URL).

## Safety

- Never print or commit secrets (pepper, device keys, passwords, secrets.h).
- Do not modify DEV-RM301-01, its key, or RM301/CEA101 schedules in tests. Never
  change admin.test's password.
- Only seeded/fake test data.
- Live check after deploy: getRoster for DEV-RM301-01 READ-ONLY, print counts only
  (cards, windows), no UIDs or keys.

## Implementation decisions (made while planning)

- **Engine reuse:** `resolveScan` decides one tap. Its "which classes meet in
  this room on this date" part (active term, manual sessions, active schedules of
  active classes in the term, their session row) moves into an exported
  `roomSlots(db, roomId, date)` in `sessions.js`; `resolveScan` and getRoster both
  call it. This is a move, not a copy. The tap-window minutes come from the same
  `early_window_minutes` / `accept_after_end_minutes` settings (`end` = scheduled
  end + `accept_after_end_minutes`, default 0, so it equals the scheduled end unless
  an admin changes it; the engine compares at minute precision, so a tap anywhere in
  the end minute counts).
- **enrolled_at:** the "joined after the session ended" check in `statusFor`
  (portal.js) becomes `joinedAfter(db, classId, studentId, date, end)`, shared by
  both.
- **roster_version:** the integer Settings counter is NOT kept for getRoster. It
  is bumped by card/student/settings changes but not by schedule, enrollment or
  cancellation changes, and windows also move as time passes. getRoster returns
  the first 16 hex characters of SHA-256 (`ctx.tokenHash`) over
  `{settings, cards, windows}`. heartbeat/submitScans still return the integer
  counter; firmware v0.5 must not compare the two.
- **roster_refresh_seconds:** no new Settings row; it carries the existing
  `heartbeat_interval_seconds` value.
- **firmware_version / queue_count:** both columns exist in Devices, so getRoster
  stores them (same validators as heartbeat; a bad value is ignored, like
  submitScans) and sets `last_seen_at`. getRoster therefore becomes a write action
  (script lock, one Devices row).
- **Cache:** not added up front; measure live first and add only if needed.
