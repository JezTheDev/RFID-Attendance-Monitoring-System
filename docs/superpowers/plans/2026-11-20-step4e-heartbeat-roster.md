# Step 4e: device.heartbeat + device.getRoster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The ESP32 can report its status (`device.heartbeat`) and download the offline roster (`device.getRoster`), and every admin action that changes the roster bumps `roster_version`.

**Architecture:** Two handlers in `backend/src/handlers/device.js`, registered in `DEVICE_ACTIONS` (`actions.js`) with declared tabs. Same path as 4d: `runDeviceAction` → `authenticateDevice` first → handler. heartbeat declares `writes: 'Devices'` → Server.gs runs it under the lock and saves only the edited row. getRoster declares no writes → no lock, nothing saved. `server_time` is already added by Server.gs (`serverTime_()`).

**Tech Stack:** Node ES modules, `node:test`, Apps Script (V8) via `tools/build_apps_script.mjs`.

**Spec:** `docs/Device_API_Spec.md` §6.2, §6.3, §7 + the task message (validation ranges, no AuditLog on heartbeat).

## Global Constraints

- Device auth first: wrong key / unknown device → `INVALID_DEVICE_KEY` before any validation.
- Invalid input → `AppError('BAD_REQUEST', ...)`; nothing written (handler throws before touching the row).
- Clock: `toManilaIso(ctx.now())` only.
- All Sheet cells plain text: numbers stored as `String(...)`, booleans as `'TRUE'`/`'FALSE'` (seed uses `"TRUE"`).
- heartbeat writes NO AuditLog row.
- Names on the roster ≤ 16 chars, reuse `shortName()` (already in device.js).
- Bundle.gs ES2020; run `node tools/build_apps_script.mjs` after `backend/src` changes.

## Review Focus

1. `battery_voltage` with float noise (`3.8200000001`) — accept, store rounded to 2 decimals (`'3.82'`), don't reject.
2. `known_version` missing / string `"12"` — compare as `Number(known_version)`; missing → full roster (never `changed:false` by accident).
3. Active card whose student is inactive (legacy data) — excluded from roster.
4. Student name edit when the student has a card — must bump, or offline LCD shows the old name until some unrelated change.
5. Reactivating a student — always bump (cheap; covers legacy inactive students who kept an active card).

---

### Task 0: Branch

- [ ] `git checkout -b step4e-heartbeat-roster`

### Task 1: device.heartbeat

**Files:** Modify `backend/src/handlers/device.js`, `backend/src/actions.js:254-257`. Test: create `backend/tests/heartbeat-roster.test.js`; modify `backend/tests/server-gs.test.js:398-414` (those tests use `device.heartbeat` as the *unknown* action → change to `device.nope`).

**Interfaces:** Produces `export function heartbeat(db, request, device, ctx) -> { roster_version: number, low_battery: boolean }`.

Validation (any failure → `BAD_REQUEST`, message names the field):
- `battery_voltage`: finite number, 0 ≤ v ≤ 6 → stored `String(Math.round(v * 100) / 100)`
- `wifi_rssi`: integer, −127 ≤ v ≤ 0
- `queue_count`: integer ≥ 0
- `time_synced`: `typeof === 'boolean'` → `'TRUE'`/`'FALSE'`
- `firmware_version`: string, trimmed length 1..32
- `uptime_seconds`: integer ≥ 0 (validated, not stored — no column)

Writes on `device` only: those 5 fields + `last_heartbeat_at` = `last_seen_at` = `toManilaIso(ctx.now())`.
`low_battery = v < Number(setting(db, 'low_battery_voltage', 3.5))`.
Action entry: `'device.heartbeat': { run: heartbeat, reads: 'Settings', writes: 'Devices' }`.

- [ ] **Step 1: failing tests** (reuse the `setup()` shape from `submit-scans.test.js`: makeDb + createDevice/generateDeviceKey/setDeviceStatus):
  - `heartbeat updates only its own device row`: snapshot `JSON.stringify` of every tab except `Devices`, and every other Devices row; after the call they are deep-equal; own row has `battery_voltage '3.82'`, `wifi_rssi '-61'`, `queue_count '0'`, `time_synced 'TRUE'`, `firmware_version '0.3.0'`, `last_heartbeat_at === last_seen_at === '2026-11-23T08:10:00+08:00'`; `db.AuditLog.length` unchanged.
  - `bad values → BAD_REQUEST, nothing written`: table of `{battery_voltage: 6.01}`, `-0.1`, `'3.8'`, `{wifi_rssi: 1}`, `-128`, `-60.5`, `{queue_count: -1}`, `1.5`, `{time_synced: 'true'}`, `{firmware_version: ''}`, `'x'.repeat(33)`, `{uptime_seconds: -1}`; each → code `BAD_REQUEST`, Devices row deep-equal to before.
  - `low_battery at threshold` (setting 3.5): `3.49 → true`, `3.5 → false`, `3.51 → false`.
  - `wrong key → INVALID_DEVICE_KEY` (also with bad fields: key error wins).
  - `admin dashboard shows heartbeat`: after heartbeat with 3.40, `getAdminDashboard` device entry has `battery_voltage 3.4`, `low_battery true`, `online true`.
  - server-gs: `device.heartbeat under the lock, tabs read = deviceTabsFor('device.heartbeat').read, rows written 1, batchUpdates 1, no AuditLog row`.
- [ ] **Step 2:** `node --test backend/tests/heartbeat-roster.test.js` → FAIL (`UNKNOWN_ACTION`).
- [ ] **Step 3:** implement `heartbeat` + action entry; update the two server-gs tests to `device.nope`.
- [ ] **Step 4:** `npm test` → all pass.
- [ ] **Step 5:** commit `feat(device): device.heartbeat (step 4e)`.

### Task 2: device.getRoster

**Files:** same as Task 1.

**Interfaces:** Produces `export function getRoster(db, request, device, ctx)` →
`{ changed: false, roster_version }` when `Number(request.known_version) === current`, else
`{ changed: true, roster_version, settings: { duplicate_window_minutes: number, heartbeat_interval_seconds: number }, cards: [{ uid, name }] }`.
`current = Number(setting(db, 'roster_version', 0)) || 0` (same expression as submitScans — extract one `rosterVersion(db)` helper in device.js, use in all three).
Cards: `RfidCards` with `status === 'active'` whose student has `account_status === 'active'`; `name = shortName(student)`.
Action entry: `'device.getRoster': { run: getRoster, reads: 'Devices RfidCards Students Settings' }` (no writes → no lock).

- [ ] **Step 1: failing tests:**
  - `unchanged → { changed:false, roster_version }` exact deepEqual, also with `known_version: '1'` (string).
  - `missing known_version → changed:true`.
  - `changed roster excludes revoked cards and inactive students`: revoke STU-0002's card, set STU-0003 inactive directly in db with an active card left → uids exclude both, include STU-0001 `A1B2C3D4`.
  - `names ≤ 16 chars`: student `first_name 'Maximiliano', last_name 'Dela Cruz-Villanueva'` → name `'M. Dela Cruz-Vil'` (16 chars); every `name.length <= 16`.
  - `settings are numbers`: `{ duplicate_window_minutes: 5, heartbeat_interval_seconds: 300 }`.
  - `wrong key → INVALID_DEVICE_KEY`.
  - server-gs: `device.getRoster: no lock, nothing written (0 batchUpdates), tabs = declared`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** `npm test` → pass.
- [ ] **Step 5:** commit `feat(device): device.getRoster (step 4e)`.

### Task 3: roster_version bumps

Audit (current code):

| Action | Changes roster? | Bumps today? |
|---|---|---|
| `admin.assignCard` (assign + replace) | yes | ✅ `students.js:305` |
| `admin.revokeCard` | yes | ✅ `students.js:326` |
| `admin.setStudentStatus` → inactive | yes (revokes card) | ✅ only inside `if (card)` |
| `admin.setStudentStatus` → active | only for legacy inactive+active-card rows | ❌ |
| `admin.updateStudent` (name change) | yes (`name` on roster) | ❌ **missing** |
| `admin.createStudent` | no (new student has no card) | — |
| Settings edits (dup window / heartbeat interval) | would, but no admin action edits Settings | — |

Fixes:
- `setStudentStatus`: move `bumpRosterVersion(db)` out of `if (card)` → bump on every status change.
- `updateStudent`: bump when `first_name` or `last_name` changed; add `Settings` to `admin.updateStudent` reads+writes in `actions.js:62` (tabs.test.js catches it otherwise).

- [ ] **Step 1: failing test** `each roster-changing admin action bumps roster_version` — table over assignCard, replace (assignCard with `replace_reason:'lost'`), revokeCard, setStudentStatus inactive, setStudentStatus active, updateStudent with new last_name: each `+1`. Plus `updateStudent changing only email → no bump`.
- [ ] **Step 2:** run → FAIL on updateStudent + activate. **Step 3:** fix. **Step 4:** `npm test` → pass.
- [ ] **Step 5:** commit `fix(roster): bump roster_version on name change and reactivation`.

### Task 4: tools/measure_device_api.mjs + build + report

- [ ] Copy the 4d scratch script (`measure-4d.mjs`) to `tools/measure_device_api.mjs`: `node tools/measure_device_api.mjs <repo-path>` (default `.`), prints submitScans rows (1/20 scans, seeded and padded 5,000), plus one line each for `device.heartbeat` and `device.getRoster` (full + unchanged): tabs read, rows read, rows written, batchUpdates.
- [ ] `npm test`, `node tools/build_apps_script.mjs`, `node --check` on every changed JS file + `backend/apps-script/Bundle.gs`.
- [ ] Run the measurement, paste output into the report and into `CLAUDE.md` "Devices" section: one line for heartbeat/getRoster (replace "heartbeat/getRoster: 4e."); add the tool to the folder layout.
- [ ] Commit `chore(tools): measure_device_api.mjs; build; docs (step 4e)`. No deploy.

## Not doing

- No `sent_at` / `uptime_seconds` storage (no columns). No AuditLog for heartbeat. No Settings editor (so no settings-driven bump). No auto-creating a missing `roster_version` Settings row.
