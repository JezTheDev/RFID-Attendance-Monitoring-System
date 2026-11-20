# Step 4d — device.submitScans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ESP32 can send 1–20 taps in one request; the server validates, de-duplicates by `scan_id`, resolves the session (`resolveScan`), saves Attendance + ScanLog + new ClassSession + device last-seen in ONE all-or-nothing write, and answers one result per scan.

**Architecture:** Pure handler `submitScans(db, request, device, ctx)` in a new `backend/src/handlers/device.js`; it mutates the in-memory db scan by scan so later scans in the batch see earlier ones. `actions.js` gets a small `DEVICE_ACTIONS` table with tab declarations; Server.gs routes `device.*` through the SAME lock/load/save path as user actions (one code path, `SERVER_BUSY` on lock timeout).

**Tech Stack:** Node ES modules, `node:test`, Apps Script (Server.gs + generated Bundle.gs). No new dependencies.

**Spec:** `docs/Device_API_Spec.md` §5, §6.1, §6.4, §7, §8 + the 4d task message (pasted in chat).

Branch: `step4d-submit-scans` (from `step4c-session-engine`). Not built: heartbeat, getRoster (4e). No deploy.

## Global Constraints

- Request: `{ action:'device.submitScans', device_id, device_key, sent_at, firmware_version, scans:[…] }`; `scans` 1–20 items, else `BAD_REQUEST`.
- Item: `scan_id` = `<device_id>-NNNNNN-NNNNNN` (must start with THIS device's id); `rfid_uid` normalized with existing `normalizeUid` then must match `/^[0-9A-F]+$/` (8/14/20 chars, same `UID_PATTERN` as students.js); `scanned_at` integer ≥ 0; `time_quality` ∈ `ntp|backfilled|unverified`; `sync_mode` ∈ `live|offline`; `sent_at` integer ≥ 0. Any bad item → `BAD_REQUEST` for the whole request, nothing saved.
- Response `data`: `{ results: [{ scan_id, result, attendance_status, final, lcd_line2 }], roster_version }` — same order as request; `final: true` for every result we produce; `attendance_status` `'PRESENT'` on ACCEPTED, `''` otherwise; `lcd_line2` ≤ 16 chars, short name (`"J. Dela Cruz"` = first initial + `". "` + last name, cut to 16) on ACCEPTED/DUPLICATE, `''` otherwise (device shows its own fixed text, spec §8.2). `roster_version` = `Number(setting('roster_version'))`.
- `ALREADY_RECORDED` result also carries `original_result` and the original `attendance_status`/`lcd_line2` rebuilt from the stored ScanLog row.
- Attendance status is `present` (as `resolveScan` returns; LATE is not in scope).
- Times: `scanned_at`/`received_at` stored as Manila ISO via `toManilaIso(ms)`; `received_at = toManilaIso(ctx.now())`.
- ScanLog/Attendance columns: exactly the existing seed columns (no new columns).
- Request-level errors (spec §6.4): `INVALID_DEVICE_KEY`, `DEVICE_DISABLED`, `DEVICE_NOT_ASSIGNED`, `BAD_REQUEST`, `SERVER_BUSY`, `SERVER_ERROR`. Rename `BUSY` → `SERVER_BUSY` everywhere.
- Never `ok:true` unless the batchUpdate succeeded. Device key never logged/stored (4b rule).

## Decision for you to OK (scale)

Idempotency needs every past `scan_id`, and `resolveScan` needs Attendance rows to detect DUPLICATE, so **ScanLog and Attendance are read fully** (declared in `writes`; new rows are still *appended*, rows written stay ~4 per scan). They grow all term (~10k+ rows each). Task 4 measures it. Smaller-read options (read only the `scan_id` column, per-term archive) are a later step if the numbers are bad — not built now.

## Review Focus

1. Same `scan_id` twice **inside one batch** → second is `ALREADY_RECORDED`, one ScanLog row (test in Task 2).
2. A `scan_id` from another device's prefix → `BAD_REQUEST` (stops one device replaying another's ids) (Task 2).
3. Student with an active card but `account_status` inactive → `UNREGISTERED` (Task 2).
4. Two different students tapping first in an unopened session in one batch → ONE new ClassSession, both ACCEPTED into it (Task 2).
5. `resolveScan` future time (> now + 5 min) with `time_quality: ntp` → `INVALID_TIME` and still a ScanLog row (Task 2).

---

### Task 1: One clock + session phase + sessions_held (4c review items)

**Files:**
- Modify: `backend/src/utils.js` (`writeAudit`, delete `manilaNow` if unused after this task), every `writeAudit(` caller (account, admin-users, device-auth, migration, academic, admins, classes, devices, instructors, portal, students), `manilaNow()` callers (admins, classes, instructors, students), `backend/src/handlers/dashboard.js:98` (`Date.now()`), `backend/src/auth/admin-users.js:33` (`nowMs` fallback), `backend/src/handlers/portal.js` (`describeSession`, `sessions_held` ×2), `dashboard.js` `describe`
- Modify tests: the ~30 handler calls without ctx get `makeCtx()`; `CLAUDE.md` (mention of `manilaNow`)
- Test: `backend/tests/portal.test.js`, `backend/tests/sessions.test.js` (or a new `clock.test.js`)

**Interfaces:**
- Produces: `writeAudit(db, session, entry, ctx)` — `timestamp = toManilaIso(ctx.now())`; ctx is required.
- Produces: session objects in `instructor.*` and `admin.getDashboard` have `phase: 'upcoming'|'in_progress'|'ended'|'cancelled'` (admin rows without a ClassSession use `sessionPhase({ status:'open', session_date:date, scheduled_start:start, scheduled_end:end }, now)`).

- [ ] **Step 1: Failing tests**
  - `writeAudit uses ctx.now()`: fake clock at `Date.UTC(2026,10,18,0,0,0)` → AuditLog row `timestamp === '2026-11-18T08:00:00+08:00'` after e.g. `createTerm`.
  - `dashboard device online uses ctx.now()`: device `last_seen_at` 1 min before fake now → `online: true`; fake now +1 day → `false`.
  - `instructor.getSession includes phase`: clock before start → `'upcoming'`, inside → `'in_progress'`; closed → `'ended'`.
  - `admin.getDashboard sessions include phase`.
  - `sessions_held skips upcoming`: an `open` session today whose start is after fake now is not counted (classSummary and getClassRoster).
- [ ] **Step 2:** `node --test` → those fail.
- [ ] **Step 3:** Implement; grep `manilaNow\|Date.now()\|new Date()` in `backend/src` → only `utils.js` definitions remain (delete `manilaNow` if nothing uses it).
- [ ] **Step 4:** `node --test` → all pass.
- [ ] **Step 5:** Commit `refactor(clock): one clock (ctx.now) for audit + timestamps; session phase; sessions_held`.

### Task 2: `submitScans` handler (pure)

**Files:**
- Create: `backend/src/handlers/device.js`
- Modify: `backend/src/actions.js` (`DEVICE_ACTIONS`, `deviceTabsFor`, `runDeviceAction`)
- Modify: `backend/tests/helpers/db.js` (add `Devices: [DEV-CPE-101-01, active, RM-0001]`; keep existing tests green)
- Test: create `backend/tests/submit-scans.test.js`; extend `backend/tests/tabs.test.js` to cover device actions

**Interfaces:**
- Consumes: `resolveScan(db, {room_id, scanned_at, student_id}, settings, nowMs)` (sessions.js), `authenticateDevice` (4b), `normalizeUid` (students.js; export `UID_PATTERN` from there), `nextId`, `toManilaIso`, `setting`.
- Produces: `submitScans(db, request, device, ctx) -> { results, roster_version }`.
- Produces in actions.js:
  ```js
  export const DEVICE_ACTIONS = { 'device.submitScans': { run: submitScans,
    reads: 'Terms Classes Schedules Enrollments RfidCards Students Settings',
    writes: 'Devices ClassSessions Attendance ScanLog' } };
  export function deviceTabsFor(name) // {read, write, append}; unknown device.* -> DEVICE_TABS
  export function runDeviceAction(db, request, ctx) // authenticateDevice first, then lookup; unknown -> UNKNOWN_ACTION
  ```
- Rows written per scan: ScanLog `log_id = nextId(ScanLog,'log_id','LOG',5)` with all seed columns (`session_id`, `student_id`, `attendance_id` `''` when none); Attendance `attendance_id = nextId(…,'ATT',5)`, `status:'present'`, `source:'device'`, `created_by:''`, override fields `''`; device `last_seen_at = received_at`, `firmware_version` if a non-empty string.

Per-scan order (from the task): validate all → for each: existing ScanLog row with this `scan_id` → ALREADY_RECORDED (no rows) → `unverified`/`scanned_at 0` → INVALID_TIME → active card + active student else UNREGISTERED → `resolveScan` → on ACCEPTED push `newSession` (if any) + Attendance → always push ScanLog.

- [ ] **Step 1: Failing tests** (fake clock `makeCtx({ startMs })` on a Monday in term, room RM-0001, CLS-0001 MON 08:00–10:00; device key via `issueDeviceKey`). Each asserts exact results and row counts:
  - accepted tap → 1 new ClassSession (`source:'auto'`, `status:'open'`), 1 Attendance (`present`, `source:'device'`, `card_id`, `device_id`, `scan_id`, `scanned_at` Manila ISO, `sync_mode`, `time_quality`), 1 ScanLog (`ACCEPTED`, ids filled); response `{result:'ACCEPTED', attendance_status:'PRESENT', final:true, lcd_line2:'C. Santos'}`; device `last_seen_at`/`firmware_version` updated.
  - second tap same student/session (same batch AND separate request) → `DUPLICATE`, lcd name, no 2nd Attendance, still a ScanLog row.
  - resend same `scan_id` → `ALREADY_RECORDED`, `original_result:'ACCEPTED'`, original lcd/status, row counts unchanged; same `scan_id` twice in one batch → second is ALREADY_RECORDED.
  - offline batch of 5 from yesterday (`sync_mode:'offline'`, two different sessions/days, oldest first) → each lands in the right session; two students first-tapping one unopened session → one new session shared.
  - unknown UID → `UNREGISTERED`, ScanLog row with `rfid_uid`, and `listUnregisteredUids(db)` lists it; revoked card → UNREGISTERED; inactive student with active card → UNREGISTERED.
  - `NOT_ENROLLED` (STU-0004 in RM-0001 Monday), `NO_ACTIVE_SESSION` (Monday 13:00), `SESSION_CANCELLED` (cancelled ClassSession), `INVALID_TIME` (`unverified`/`0`, and ntp 10 min in the future).
  - 20 scans OK (20 results, same order); 21 → `BAD_REQUEST`, 0 → `BAD_REQUEST`; bad `rfid_uid` `'04:a1:b2:c3'` normalizes OK, `'XYZ'` → BAD_REQUEST; other device's scan_id prefix → BAD_REQUEST; bad `time_quality`/`sync_mode` → BAD_REQUEST; nothing pushed on BAD_REQUEST.
  - wrong key → `INVALID_DEVICE_KEY` through `runDeviceAction`, db unchanged.
  - every `lcd_line2.length <= 16` (long last name test).
  - end-to-end: tap via `runDeviceAction` → `instructor.getSession` (Ana) shows STU-0001 `present` → `student.getHistory` (student1) shows it.
- [ ] **Step 2:** `node --test backend/tests/submit-scans.test.js` → fails (module missing).
- [ ] **Step 3:** Implement `device.js` + actions.js changes.
- [ ] **Step 4:** `node --test` → all pass (incl. tabs.test.js strict guard for `device.submitScans`).
- [ ] **Step 5:** Commit `feat(device): device.submitScans (step 4d)`.

### Task 3: Server.gs device route under the lock + SERVER_BUSY

**Files:**
- Modify: `backend/apps-script/Server.gs` (`handleRequest_`/`handleDeviceRequest_` → one path; `BUSY` → `SERVER_BUSY`; header comment)
- Test: `backend/tests/server-gs.test.js` (busy test renamed; new device tests in the 4b `withDevice()` block)
- Docs: `docs/BACKEND_VERIFICATION.md`, `docs/AUDIT_REPORT.md` (ISS-09 fixed), `CLAUDE.md` (device section: submitScans exists)

**Interfaces:**
- Consumes: `RFID.deviceTabsFor(action)`, `RFID.runDeviceAction(db, request, ctx)`.
- Server behavior: `device.*` with writes → lock (`SERVER_BUSY` on timeout), `loadDb_(spec)`, run, `saveDb_` once; AppError → `ok:false`, nothing saved; save failure → `SERVER_ERROR`.

- [ ] **Step 1: Failing tests** (after `node tools/build_apps_script.mjs`):
  - busy lock → `SERVER_BUSY` (user action and `device.submitScans`), nothing saved.
  - `device.submitScans` over doPost: `ok:true`, ACCEPTED, exactly 1 batchUpdate, tabs read = declared set, rows written = 4 (ClassSessions, Attendance, ScanLog, Devices) for a first tap.
  - wrong key → `INVALID_DEVICE_KEY`, 0 batchUpdates, cells unchanged.
  - `stats.failNext = true` → `SERVER_ERROR`, `allCells(ss)` unchanged.
  - existing 4b test "device.heartbeat → UNKNOWN_ACTION, reads only Devices" still passes.
- [ ] **Step 2:** build + `node --test` → new tests fail.
- [ ] **Step 3:** Implement Server.gs.
- [ ] **Step 4:** build + `node --test` → pass.
- [ ] **Step 5:** Commit `feat(server): device.submitScans under the lock; SERVER_BUSY`.

### Task 4: Measure + verify + final commit

- [ ] **Step 1:** Scratchpad script using `helpers/fake-apps-script.js` `makeServer()` + `setupSheets()` (the seeded TEST Sheet, as 4a's tests use), then the same with ScanLog and Attendance padded to 5,000 rows each: print `stats.tabsRead`, `rowsRead`, `rowsWritten`, `batchUpdates` for a 1-scan and a 20-scan request.
- [ ] **Step 2:** `node --test`, `node tools/build_apps_script.mjs`, `node --check` on every changed JS file; paste outputs.
- [ ] **Step 3:** Commit docs if any left; no deploy.
