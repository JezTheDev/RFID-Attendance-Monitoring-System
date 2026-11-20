# Step 4f-prep: Live Device Test Tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tools to test the REAL deployed Apps Script like the ESP32 does: editor helpers that open/close a temporary class slot on the TEST Sheet, and a Node script that fires real device requests and checks the answers.

**Architecture:** `prepareLiveTest` / `cleanupLiveTest` live in `backend/src/maintenance.js` (already bundled and exported as `RFID.*`) and run through Server.gs `runEditorJob_`. The new slot is made by the existing `addSchedule` handler, so the own-overlap and room/instructor/section clash checks are the SAME code as the Admin portal. `tools/live_device_test.mjs` is plain Node 18+ `fetch` with `redirect: 'manual'`; its checking logic is exported so a test can run it against a local fake HTTP server.

**Tech Stack:** Node ≥18 (`fetch`, `node:http`, `node:test`), Apps Script V8. No npm deps.

**Spec:** user task "4f-prep" (this conversation), `docs/Device_API_Spec.md` §3.1, §6, §8.1, `CLAUDE.md`.

## Global Constraints

- Branch `step4f-live-test` (from `main`). Do NOT deploy.
- Both helpers refuse unless Script Property `TEST_SEED_PASSWORD` is set → `AppError('NOT_TEST_SHEET', …)`, same as `issueTestDeviceKey`.
- Never delete rows; cleanup only sets schedules `inactive`.
- Device key comes only from env `DEVICE_KEY`, never printed, never in a repo file.
- Times: Manila, `ctx.now()` + `manilaAt()`; Sheet cells plain text `HH:mm`, day codes `MON..SUN`.
- Bundle.gs must stay ES2020; after editing `backend/src`: `node tools/build_apps_script.mjs`, `npm test`, `node --check` on changed JS.

## Decisions (please check these)

1. **Marker:** Schedules has no `notes` column, and I don't want a schema change for a test tool. The marker is an **AuditLog row** `action: 'LIVE_TEST_SCHEDULE'`, `entity_id: <schedule_id>`, `reason: 'LIVE TEST (prepareLiveTest) — run cleanupLiveTest after'`. Cleanup finds schedules through those rows. (Alternative if you prefer it visible in the Schedules tab: add a `notes` column — tell me.)
2. **Slot:** `start = max(00:00, now−10)`, `end = min(23:59, now+60)`, day = today's code. Created by `addSchedule(db, {class_id, room_id, day_of_week, start_time, end_time}, SYSTEM, ctx)` with `SYSTEM = { user_id: '', role: 'system' }`.
3. **Picking room + class:** loop active devices with a room (sorted by device_id) × active classes in the active term that covers today (sorted by class_id). A pair qualifies when the class has ≥3 enrolled students with an active card AND there is ≥1 active-card student NOT enrolled in it; first pair whose `addSchedule` does not throw wins. If none → `AppError('NO_LIVE_TEST_SLOT', …)` listing why (no active term today / no device / every slot clashes).
4. **Idempotent:** if a marked schedule is `active`, for today's day code, and covers now (`start ≤ now ≤ end`) → reuse it (no writes, same log). Marked schedules that are active but stale are set inactive (via `removeSchedule`) before creating a new one.
5. **Unknown UID:** first of `FFFFFF00`, `FFFFFF01`, … not present in RfidCards (any status).
6. **Repeat tests expected results** (only the 3 enrolled UIDs exist, all already ACCEPTED after the live scan): 20-scan offline batch = 20 × `DUPLICATE` (UIDs cycled, `sync_mode: 'offline'`, `scanned_at` = now−60…now−41); 40 sequential and 10 parallel single scans = `DUPLICATE`, except the parallel ones also accept request-level `SERVER_BUSY` (counted, not a FAIL).

**Changed after review (user, 2026-11-20):** `prepareLiveTest` logs ALL enrolled carded students as `LIVE_UIDS` and picks the class with the most of them. The tool computes expected results per UID (first scan = ACCEPTED, later = DUPLICATE, resent scan_id = ALREADY_RECORDED); the offline batch takes half of the not-yet-scanned students (real saves), the 40 sequential scans the rest. It prints single-scan timing per result (ACCEPTED vs DUPLICATE) and a clear SERVER_BUSY count (not a FAIL).

## Review Focus

1. Run near midnight (e.g. 23:30) → slot clamped to `23:59`, still valid; before 00:10 → start clamps `00:00`. Test both.
2. Room busy with a seeded class right now → that room is skipped, next device's room used; clash check is never bypassed.
3. `prepareLiveTest` run twice → second run creates nothing (Schedules + AuditLog length unchanged).
4. Apps Script answers **200 directly** (no redirect) or the GET body is not JSON → tool reports FAIL with the HTTP code, not a crash.
5. The key must not leak: the tool's printed output (incl. error messages) never contains `DEVICE_KEY`; wrong-key test uses a different random key.

---

### Task 1: Editor helpers `prepareLiveTest` / `cleanupLiveTest`

**Files:**
- Modify: `backend/src/maintenance.js` (add both + imports `addSchedule`, `removeSchedule` from `handlers/classes.js`, `AppError`, `manilaAt`, `dayCodeOf`, `writeAudit` from `utils.js`)
- Modify: `backend/apps-script/Server.gs` (two editor wrappers after `issueTestDeviceKey`)
- Test: `backend/tests/live-test.test.js`

**Interfaces:**
- Produces: `prepareLiveTest(db, ctx) -> { schedule_id, device_id, room_id, room_code, class_id, class_label, day_of_week, start_time, end_time, reused: boolean, enrolled_uids: string[3], not_enrolled_uid, unknown_uid }`
- Produces: `cleanupLiveTest(db, ctx) -> string[]` (lines; "Nothing to change: no active LIVE TEST schedule." when none)
- Server.gs: `prepareLiveTest()` logs every field + ready-to-paste env lines (`LIVE_UIDS=…,…,…`, `NOT_ENROLLED_UID=…`, `UNKNOWN_UID=…`); `cleanupLiveTest()` logs the lines. Both via `runEditorJob_`.

- [ ] **Step 1: Write failing tests** (`makeDb()` + `makeCtx({ startMs })`, Manila Mon 2026-11-23; fake clock set per test)
  - `refuses on a non-test Sheet`: ctx props without `TEST_SEED_PASSWORD` → both throw `NOT_TEST_SHEET`; Schedules unchanged.
  - `creates an active slot now−10..now+60 in a room with an active device`: clock Mon 11:00 → `start_time '10:50'`, `end_time '12:00'`, `day_of_week 'MON'`, schedule status active, AuditLog has `LIVE_TEST_SCHEDULE` row for it; 3 distinct enrolled UIDs, all active cards of students enrolled in `class_id`; `not_enrolled_uid` is an active card of a student not enrolled; `unknown_uid` not in RfidCards.
  - `the device then ACCEPTs an enrolled tap`: `resolveScan(db, {room_id, scanned_at: now/1000, student_id}, {}, now)` → `ACCEPTED` with `class_id` = the chosen class.
  - `passes the clash check`: `findScheduleClashes(db)` returns the same lines before and after.
  - `skips a busy room`: clock Mon 08:00 (seeded CLS-0001 in ROM-0001) → chosen `room_id !== 'ROM-0001'`.
  - `clamps near midnight`: 23:30 → `end_time '23:59'`; 00:05 → `start_time '00:00'`.
  - `is idempotent`: second call → `reused: true`, same `schedule_id`, Schedules and AuditLog lengths unchanged.
  - `replaces a stale slot`: prepare at 11:00, move clock to Tue 11:00, prepare → old schedule `inactive`, new one active on `TUE`.
  - `cleanup deactivates, never deletes`: after prepare + one ACCEPTED attendance row pushed, cleanup → schedule `inactive`, Schedules/Attendance/ScanLog lengths unchanged; second cleanup → "Nothing to change…".
  - `NO_LIVE_TEST_SLOT when no active term covers today`: clock 2027-02-01 → throws.
  (Use `backend/tests/helpers/db.js` fixtures; if the in-memory db lacks a free room/student, add rows inside the test, not to the helper.)

- [ ] **Step 2:** `node --test backend/tests/live-test.test.js` → FAIL (not exported).
- [ ] **Step 3:** Implement per Decisions 1–5. Reuse `addSchedule` / `removeSchedule` (no copied clash logic).
- [ ] **Step 4:** Add the two Server.gs wrappers; `node tools/build_apps_script.mjs`; `node --test` → all PASS. Add one case to `server-gs.test.js`: `context.prepareLiveTest()` then `context.cleanupLiveTest()` run on the fake Sheet without throwing and the Schedules tab gains one row that ends `inactive`.
- [ ] **Step 5:** Commit `feat(live-test): prepareLiveTest / cleanupLiveTest editor helpers (TEST Sheet only)`.

### Task 2: `tools/live_device_test.mjs`

**Files:**
- Create: `tools/live_device_test.mjs`
- Test: `backend/tests/live-device-tool.test.js`

**Interfaces:**
- Env (all required, else print which are missing, exit 2): `API_URL`, `DEVICE_ID`, `DEVICE_KEY`, `LIVE_UIDS` (3 comma-separated), `NOT_ENROLLED_UID`, `UNKNOWN_UID`.
- Exports (script runs `main()` only when it is the entry file: `import.meta.url === pathToFileURL(process.argv[1]).href`):
  - `postDevice(url, body) -> Promise<{ status, json, ms }>`: POST JSON with `redirect: 'manual'`; 302 → GET `Location` (new request); 200 → body; else / non-JSON → `{ status, json: null }`. `ms` = whole round-trip.
  - `runLiveTest({ url, deviceId, key, uids, notEnrolledUid, unknownUid, post = postDevice }) -> Promise<rows>`; row = `{ test, expected, got, pass, ms: number[] }`.
  - `formatTable(rows) -> string` columns `test | expected | got | PASS/FAIL | ms` (one ms, or `min / median / max` when >1).
- scan_id = `${DEVICE_ID}-${boot}-${seq}` with `boot` = 6 digits from `Date.now()` seconds mod 1e6 (new per run so reruns are not ALREADY_RECORDED), `seq` 6 digits counting up.
- Tests, in order: `heartbeat` (ok, has `roster_version`) · `getRoster known_version 0` (ok, `changed:true`, cards ≥ 3) · `live scan` ACCEPTED · `same scan_id` ALREADY_RECORDED · `same student new scan_id` DUPLICATE · `not-enrolled UID` NOT_ENROLLED · `unknown UID` UNREGISTERED · `20-scan offline batch` 20×DUPLICATE · `wrong key` INVALID_DEVICE_KEY (random 64-hex key) · `40 sequential` all DUPLICATE · `10 parallel` DUPLICATE or SERVER_BUSY (got shows e.g. `8 DUPLICATE, 2 SERVER_BUSY`).
- Exit code 1 if any row fails; the key is never put in `got` or printed.

- [ ] **Step 1: Write failing tests** with a local `node:http` server on port 0 that answers POST with `302 Location: /r/<n>` and GET `/r/<n>` with a canned JSON, scripted by action/uid:
  - `happy path → every row PASS` (fake returns the expected codes).
  - `wrong result → that row FAIL` (fake returns ACCEPTED for the not-enrolled UID).
  - `200 without redirect works`; `non-JSON body → FAIL, no throw`.
  - `parallel SERVER_BUSY is counted, not failed`.
  - `formatTable` shows `min / median / max` for the 40-row case.
  - `key never in output`: `formatTable(rows)` does not contain the key.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `node --test` → PASS; `node --check tools/live_device_test.mjs`; `node tools/live_device_test.mjs` with no env → prints missing vars, exit 2.
- [ ] **Step 5:** Commit `feat(tools): live_device_test.mjs for the deployed Web App (step 4f)`.

### Task 3: Docs

**Files:** Modify `backend/README.md` (new `## Live test (4f)` before `## Limits to keep in mind`); one line in `CLAUDE.md` (Server.gs editor jobs list + tools list).

Steps in the section: (1) `npm test`, build, paste Server.gs/Bundle.gs/SeedData.gs, New version → Deploy (TEST Sheet only); (2) wrapper `function issueKeyForLiveTest() { issueTestDeviceKey('DEV-RM302-01'); }` — use the `device_id` that `prepareLiveTest` logs, so run prepare first; (3) run `prepareLiveTest`, copy logged lines; (4) env vars — PowerShell `$env:API_URL = '…/exec'` etc. and Git Bash `export API_URL='…/exec'`; key typed only in the terminal; (5) `node tools/live_device_test.mjs`; (6) `cleanupLiveTest`; then delete the wrapper. Note: rerun prepare gives the same slot within the hour.

- [ ] Write, then final verification: `node --test`, `node tools/build_apps_script.mjs`, `node --check` on all changed JS; commit `docs: live test (4f) steps`.
