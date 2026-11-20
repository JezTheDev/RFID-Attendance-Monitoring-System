# Step 4b — Devices admin, device keys, device authentication (design)

Approved in chat 2026-11-20. Backend only. Not in scope: `device.submitScans`,
`device.heartbeat`, `device.getRoster`, the session engine, frontend pages.

## Why

Admins must register ESP32 readers, put each in one room, and give each a
secret key (shown once). Every later `device.*` call (4c+) goes through one
shared check. This is the security base for the device API.

## Approaches

- **Chosen:** a key per device, sent in the JSON body over HTTPS; the server
  stores `SHA-256(pepper + key)` only (Device API Spec §4, option A).
- HMAC request signing (option B): stronger against replay, but more firmware
  work and needs device time. Kept as a later upgrade.
- Password-style hash (300 iterations): not needed, since the key is 32 random
  bytes and cannot be guessed; it would add ~360 ms to every tap.

## Decisions

Admin actions (role admin, audited, tabs declared):
`admin.listDevices`, `admin.createDevice {device_name, room_id, notes?}`,
`admin.updateDevice {device_id, device_name, notes?}`,
`admin.setDeviceStatus {device_id, status}`, `admin.assignDeviceRoom {device_id, room_id}`,
`admin.generateDeviceKey {device_id}`.

- `device_id` = `DEV-<room_code>-NN`, NN = highest existing NN for that prefix + 1
  (devices are never deleted, so an id is never reused). It is never renamed
  when the device moves to another room.
- A new device starts as **maintenance** (it has no key yet).
- Statuses: `active` / `maintenance` / `retired`. Retired is final and clears
  `device_key_hash`. No delete.
- Setting **active** is rejected without a key ("Generate a key first") and when
  the room already has another ACTIVE device (the message names it).
  `assignDeviceRoom` applies the same check when it moves an active device.
- `assignDeviceRoom` with `room_id: ''` unassigns. Target room must exist and be active.
- `device_key_hash` never leaves the server: lists show `has_key`, audit rows
  never contain the hash or the key.
- Key = `randomHex(32)` (64 hex characters, URL-safe), returned once as
  `device_key`. A new key replaces the old one immediately.

Device authentication `authenticateDevice(db, request, ctx)`:
- Missing `device_id`/`device_key` → `BAD_REQUEST` (firmware bug, reveals nothing).
- Order: **key first** (an unknown device still hashes the key, same timing),
  then status, then room. Unknown device or wrong key → `INVALID_DEVICE_KEY`;
  not active → `DEVICE_DISABLED`; no room → `DEVICE_NOT_ASSIGNED`.
- No user session is used or created. Server.gs routes `device.*` before the
  normal action lookup, loads only `Devices`, authenticates, then answers
  `UNKNOWN_ACTION` (no device actions exist yet).

Editor-only `issueTestDeviceKey(device_id)`: TEST Sheet only. Refuses unless
`TEST_SEED_PASSWORD` is set (the test-Sheet marker, which must never be set on
production). Logs the key once.
