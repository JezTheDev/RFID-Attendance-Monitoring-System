# Backend Verification Report

| | |
|---|---|
| Date | 2026-11-19 |
| Branch | `backend-verification` (from `hash-iterations-300`, which includes `docs/PROJECT_CONTEXT.md`) |
| Scope | **Backend only**: `backend/src`, `backend/apps-script/Server.gs`, seed data. Frontend not reviewed. |
| Method | Read every handler; ran the code in Node; wrote tests for what we rely on and for every bug found. No backend logic was changed. |
| Updated | 2026-11-20 (branch `admin-corrections`): every requirement row, Part 3 and Part 4 re-checked against the code and tests after Step 4. The Evidence section below is the original 2026-11-19 run; the current suite is 565 tests, 0 fail, 0 todo. |
| Not checked | The live Apps Script / Google Sheet (speed, sharing settings, real quotas). Anything marked **UNVERIFIED** needs that. |

**Expected load (assumed):** one department; a few RFID devices (one per room); classes of about 40 students
who tap within the first minutes of class; up to a few hundred students logging in to check records.

**Legend:** **MET** = works, proven by a test or a line I read · **PARTIAL** = some of it works · **MISSING** = not built ·
**WRONG** = built, but gives a wrong result · **N/A** = hardware only, nothing for the backend to do.

## Evidence (fresh run on this branch)

```
$ node --test
ℹ tests 132
ℹ suites 31
ℹ pass 124
ℹ fail 0
ℹ todo 8        <- the 8 confirmed bugs below (they run, fail, and are reported as TODO)
exit code 0

$ node tools/build_apps_script.mjs
Wrote backend/apps-script/Bundle.gs (17 modules: config, utils, auth/session, auth/passwords, auth/account,
  auth/admin-users, handlers/dashboard, handlers/classes, handlers/students, handlers/academic,
  handlers/instructors, handlers/portal, handlers/admins, actions, auth/context, auth/crypto-apps-script, auth/migration)
Wrote backend/apps-script/SeedData.gs
```

The rebuilt `Bundle.gs` was identical to the committed one except the date in its header line, so it is in sync with `backend/src`.

New tests added on this branch:
- `backend/tests/verification.test.js`: every READ action leaves the db unchanged (Server.gs never saves after a read);
  Asia/Manila day boundary at 23:59:59 vs 00:00; 8 bug tests marked `todo`.
- `backend/tests/server-gs.test.js`: write actions take and release the script lock, reads do not; a busy lock
  answers `SERVER_BUSY` (renamed in step 4d, spec 6.4) and saves nothing. (Checked that the lock test fails if Server.gs locks every request.)

**Password hash iterations:** already **300** on this branch (commit `9b58e71`), from your benchmark
(1.197 ms × 300 ≈ 359 ms per hash). Old 1500-iteration hashes still verify (`auth.test.js`:
"still accepts a hash made with the old 1500-iteration constant"). Nothing else needed changing.

---

## Part 1 — Requirements traceability

Sources: **PC** = `docs/PROJECT_CONTEXT.md`, **CL** = `CLAUDE.md`, **AR** = `docs/RFID_Attendance_System_Architecture.md`.
Test names are from `backend/tests/<file>`.

### 1A. Required system features (PC §6)

| # | Requirement | Source | Backend action(s) / function(s) | Test(s) / evidence | Status | Notes |
|---|---|---|---|---|---|---|
| F1 | RFID-based attendance recording | PC §6 | `device.submitScans` (`handlers/device.js`) | `submit-scans.test.js` "creates the session, an Attendance row and a ScanLog row" | MET (backend) | Remains: firmware (MFRC522 read, send to the Web App). |
| F2 | Online database synchronization (device → Sheet) | PC §6 | `device.submitScans`, `device.heartbeat`, `device.getRoster` | `submit-scans.test.js`, `devices.test.js` | MET (backend) | Remains: firmware (calling the three actions). |
| F3 | Accurate timestamping | PC §6, §13 | `utils.manilaNow`, `utils.toManilaIso`; `submitScans`: device epoch `scanned_at` → Manila ISO, `INVALID_TIME` for unverified / 0 / far-future times | `actions.test.js` manilaNow; `passwords.test.js` toManilaIso; `verification.test.js` Manila day boundary; `submit-scans.test.js` "INVALID_TIME …" | MET (backend) | Remains: firmware (NTP sync, send `time_quality`). |
| F4 | Web-based attendance dashboard (data) | PC §6 | `admin.getDashboard`, `instructor.getDashboard`, `student.getOverview` | `portal.test.js`; `verification.test.js` READ check | MET | Bugs 4 and 7 affect some numbers. |
| F5 | Rechargeable battery operation | PC §6 | — | — | N/A | Hardware. |
| F6 | Offline buffering + automatic sync (server side) | PC §6, §13 | `submitScans`: 1–20 scans per request, `scan_id` idempotency, past `scanned_at` placed in the right session | `submit-scans.test.js` "a batch of 5 from yesterday…", "a resent scan_id is ALREADY_RECORDED…" | MET (backend) | Remains: firmware (offline queue on the device, resend when back online). |
| F7 | LED + buzzer feedback (server returns result codes) | PC §6 | `submitScans` per-scan `result` (ACCEPTED, DUPLICATE, UNREGISTERED, NOT_ENROLLED, NO_ACTIVE_SESSION, SESSION_CANCELLED, INVALID_TIME, ALREADY_RECORDED) + `lcd_line2` | `submit-scans.test.js` one test per result | MET (backend) | Remains: firmware (map each result to LED / buzzer / LCD). |
| F8 | Low-battery monitoring with dashboard alerts | PC §6 | `device.heartbeat` writes `battery_voltage`, returns `low_battery` (< Settings `low_battery_voltage`); `dashboard.js` alert | `heartbeat-roster.test.js` "low_battery at the threshold", "admin dashboard shows the heartbeat battery and online status" | MET (backend) | Remains: firmware (measure the battery, send heartbeats). |
| F9 | Duplicate-scan prevention (server layers) | PC §6, AR §6.9 | `submitScans`: one Attendance row per student per session (DUPLICATE) + `scan_id` idempotency (ALREADY_RECORDED) | `submit-scans.test.js` "second tap … is DUPLICATE", "the same scan_id twice in one batch" | MET (backend) | Remains: firmware (the `duplicate_window_minutes` cooldown on the device, delivered by `device.getRoster`). |

### 1B. Admin (PC §8)

| # | Requirement | Source | Backend action(s) | Test(s) / evidence | Status | Notes |
|---|---|---|---|---|---|---|
| A1 | Manage student accounts | PC §8 | `admin.listStudents/getStudent/createStudent/updateStudent/setStudentStatus` | `users.test.js` creating/updating accounts | MET | BUG-2 fixed: changing section moves enrollments. |
| A2 | Register and assign RFID UIDs | PC §8 | `admin.assignCard`, `revokeCard`, `listUnregisteredUids` | `cards.test.js` (11 tests) | MET | `listUnregisteredUids` has no test (read `students.js:333-350`); it only fills once devices log scans. |
| A3 | Manage instructors | PC §8 | `admin.list/create/update/setInstructorStatus` | `users.test.js` | MET | |
| A4 | Manage courses and sections | PC §8 | programs / sections / subjects / terms / rooms in `academic.js`; `admin.*Class*`, schedules, enrollments in `classes.js` | `classes.test.js` (schedules, enrollments); `academic.js` read fully | MET | `academic.js` has **no unit tests**. BUG-3 (room double-booking). |
| A5 | View all attendance records | PC §8 | `admin.listAttendance` (all rows, filters, paging), `admin.getAttendanceReport`, `admin.getDashboard` | `admin-attendance.test.js` | MET (backend) | Remains: frontend (admin attendance page). |
| A6 | Generate reports | PC §8 | `admin.listAttendance`, `admin.getAttendanceReport` (`attendance.js`) | `admin-attendance.test.js` | MET (backend) | Remains: frontend (admin report page + CSV export). Same as D7. |
| A7 | Monitor device status | PC §8 | `admin.listDevices` / `createDevice` / `setDeviceStatus` / `assignDeviceRoom` / `generateDeviceKey`; `device.heartbeat` updates the status fields; `admin.getDashboard` → `devices[]` | `devices.test.js`, `heartbeat-roster.test.js` | MET (backend) | Remains: frontend (admin devices page; the dashboard already shows `devices[]`). |
| A8 | Manage application settings | PC §8 | `admin.getSettings`, `admin.updateSettings` (`settings.js`) | `settings.test.js` (ranges, all-or-nothing, admin only) | MET (backend) | Remains: frontend (admin settings page). |

### 1C. Instructor (PC §8)

| # | Requirement | Source | Backend action(s) | Test(s) / evidence | Status | Notes |
|---|---|---|---|---|---|---|
| I1 | View assigned classes and sections | PC §8 | `instructor.getDashboard`, `listSessions` | `portal.test.js` "dashboard lists only the instructor's classes" | MET | |
| I2 | Monitor student attendance | PC §8 | `instructor.getSession`, `getClassRoster` | `portal.test.js` | MET | BUG-7 fixed (step 4c). |
| I3 | View class attendance history | PC §8 | `instructor.listSessions`, `getStudentHistory` | `portal.test.js` "cannot read the history of a student who is not in their class" | MET | |
| I4 | Filter attendance by date | PC §8 | optional `{from,to}` on `instructor.listSessions`, `getClassRoster`, `getStudentHistory`, `getClassReport` (`dateRange` in `utils.js`); `instructor.getDashboard {date}` | `date-filters.test.js` | MET | |
| I5 | Generate and export class reports | PC §8 | `instructor.getClassReport` | `portal.test.js` "cannot list sessions, roster, or report of another instructor's class" | MET | Backend gives the data; the CSV is made in the browser. |
| I6 | Correct attendance (with reason, audited) | AR §7.1 | `instructor.correctAttendance` | `portal.test.js` (ownership) | MET | Ownership is correct; BUG-1, BUG-6 and BUG-8 fixed. |

### 1D. Student (PC §8)

| # | Requirement | Source | Backend action(s) | Test(s) / evidence | Status | Notes |
|---|---|---|---|---|---|---|
| S1 | Log in to their personal account | PC §8 | `auth.login` | `auth.test.js` (26 tests) | MET | |
| S2 | View attendance summary | PC §8 | `student.getOverview` | `portal.test.js` "overview and profile describe the signed-in student only" | MET | |
| S3 | View personal attendance history | PC §8 | `student.getHistory` | `portal.test.js` "ignores a student_id sent in the request" | MET | |
| S4 | Check scan dates and timestamps | PC §8 | `historyRows` → `scanned_at` (`portal.js:514`) | read | MET | Time is shown only for device taps (manual entries have none, by design). |
| S5 | Filter records by date | PC §8 | optional `{from,to}` on `student.getHistory` and `student.getOverview` | `date-filters.test.js` | MET (backend) | Frontend has no date inputs yet. |
| S6 | View registered student information | PC §8 | `student.getProfile` | `users.test.js` "shows username / must change / locked, never a hash" | MET | |
| S7 | Cannot edit own attendance or see others' records | PC §8 | no `student.*` write action; `linkedId()` (`portal.js:16-22`) | `actions.test.js` roles; `portal.test.js` ownership tests | MET | |

### 1E. Dashboard data (PC §9)

| # | Requirement | Source | Backend field(s) | Test(s) / evidence | Status | Notes |
|---|---|---|---|---|---|---|
| D1 | Admin: total registered students | PC §9A | `stats.active_students` (`dashboard.js:150`) | read | MET | |
| D2 | Admin: total instructors | PC §9A | `stats.active_instructors` | read | MET | |
| D3 | Admin: present students today | PC §9A | `stats.students_present` (`dashboard.js:76-78`) | read | MET | Counts by the Manila date in `scanned_at`; device rows must be stored with `+08:00`. |
| D4 | Admin: attendance statistics | PC §9A | `stats.attendance_rate`, `sessions[]` counts | `verification.test.js` BUG-4 | MET | BUG-4 fixed. |
| D5 | Admin: student / instructor / course-section management | PC §9A | see A1, A3, A4 | see above | MET | |
| D6 | Admin: attendance management | PC §9A | `admin.correctAttendance` (`attendance.js`) → shared `correctAttendance` (`portal.js`) | `admin-corrections.test.js` | MET (backend) | Same rules as the instructor correction (one shared core); no ownership limit. Frontend still to do. |
| D7 | Admin: reports | PC §9A | `admin.listAttendance`, `admin.getAttendanceReport` (`attendance.js`) | `admin-attendance.test.js` | MET (backend) | Backend only; frontend page + CSV still to do. |
| D8 | Admin: device monitoring | PC §9A | `devices[]`, offline / low-battery / queue alerts, fed by `device.heartbeat` | `heartbeat-roster.test.js` "admin dashboard shows the heartbeat battery and online status"; `admin-attendance.test.js` "shows queued offline scans per device" | MET (backend) | Same as A7. |
| D9 | Instructor: assigned classes | PC §9B | `classes[]` | `portal.test.js` | MET | |
| D10 | Instructor: total students per section | PC §9B | `classes[].enrolled`, `stats.students` | read `portal.js:230-236` | MET | |
| D11 | Instructor: present and absent counts | PC §9B | `sessions[].present/late/absent` | `portal.test.js` absent tests | MET | BUG-7 fixed (step 4c): `not_scanned` count while running. |
| D12 | Instructor: recent attendance activity | PC §9B | sessions of the chosen date only | read | PARTIAL | No feed of recent taps for the instructor's classes. |
| D13 | Instructor: attendance history + report generation | PC §9B | see I3, I5 | see above | MET | |
| D14 | Student: overview, percentage, history, scan time, profile | PC §9C | `student.getOverview` (`totals.rate`), `getHistory`, `getProfile` | `portal.test.js` | MET | |

### 1F. System logic (PC §13)

| # | Requirement | Source | Backend | Test(s) / evidence | Status | Notes |
|---|---|---|---|---|---|---|
| L1 | RFID validation: registered → accept, else reject + result | PC §13 | `submitScans`: active card of an active student → ACCEPTED; else UNREGISTERED (logged in ScanLog) | `submit-scans.test.js` "unknown UID", "a revoked card", "an active card of an inactive student" | MET (backend) | Remains: firmware (show the reject result). |
| L2 | Duplicate prevention, 5 min, configurable | PC §13 | Settings `duplicate_window_minutes` (editable via `admin.updateSettings`) → `device.getRoster`; server: one Attendance row per student per session (`DUPLICATE`) | `heartbeat-roster.test.js` "missing or older known_version → full roster with numeric settings"; `settings.test.js` "roster_version +1 when duplicate_window_minutes changes"; `submit-scans.test.js` DUPLICATE | MET (backend) | Remains: firmware (enforce the cooldown on the device). |
| L3 | Timestamping, Asia/Manila | PC §13 | `manilaNow`, `toManilaIso`; device epoch → Manila ISO in `submitScans` | `verification.test.js` boundary tests; `submit-scans.test.js` | MET (backend) | Same as F3. |
| L4 | Offline sync: confirm, no duplicates during sync | PC §13 | `submitScans` returns one result per `scan_id`; a resent `scan_id` → ALREADY_RECORDED + `original_result`, no new rows | `submit-scans.test.js` "a resent scan_id is ALREADY_RECORDED…" | MET (backend) | Remains: firmware (drop a queued scan only after its result comes back). |
| L5 | Dashboard: real attendance data | PC §13 | reads Attendance / ClassSessions | `portal.test.js`; `submit-scans.test.js` "tap -> instructor.getSession shows the student present -> student.getHistory shows it" | MET | `submitScans` creates the ClassSession on the first tap. |
| L6 | Dashboard: device status + battery | PC §13 | see F8 / A7 | `heartbeat-roster.test.js` | MET (backend) | Remains: firmware (heartbeats) and the frontend devices page. |
| L7 | Distinguish pending offline vs synced records | PC §13 | `submitScans` stores `sync_mode` (Attendance + ScanLog); `heartbeat` stores `queue_count`; shown in `instructor.getSession`, the dashboard alert and report `pending_offline_scans` | `submit-scans.test.js` (sync_mode stored, offline batch); `admin-attendance.test.js` "shows queued offline scans per device" | MET (backend) | Remains: firmware (send `sync_mode` / `queue_count`). |

### 1G. Security and privacy (PC §14)

| # | Requirement | Source | Backend | Test(s) / evidence | Status | Notes |
|---|---|---|---|---|---|---|
| X1 | Role-based access control | PC §14 | `runAction` (`actions.js:101-115`) | `auth.test.js` "enforces the role of each action on the server"; `users.test.js` "is admin-only on the server" | MET | |
| X2 | Secure authentication | PC §14, CL | `auth/account.js` | `auth.test.js` | MET | See design risks R1, R2 (Part 2). |
| X3 | Passwords never stored in plaintext | PC §14 | `auth/passwords.js` | `passwords.test.js`; `migration.test.js` seed test | MET | |
| X4 | Students only access their own records | PC §14 | `linkedId()` from the session | `portal.test.js` "student can only see their own data" (3 tests) | MET | |
| X5 | Instructors only access their assigned classes | PC §14 | `ownClass()` (`portal.js:131-137`) | `portal.test.js` (4 tests) | MET | |
| X6 | Admin functions protected | PC §14 | role `admin` in `actions.js` | `actions.test.js`, `auth.test.js` | MET | |
| X7 | No secret credentials in frontend / responses | PC §14 | secrets only in Script Properties (`context.js`) | `auth.test.js` "no response or audit row contains a password, a hash, or a token hash" | MET | Backend side only. |
| X8 | Validate incoming ESP32 requests | PC §14 | `authenticateDevice` (`auth/device-auth.js`): peppered key hash; strict field checks in `submitScans` / `heartbeat` (`BAD_REQUEST`) | `devices.test.js` "unknown device and wrong key give the SAME error"; `submit-scans.test.js` bad-input tests | MET (backend) | Remains: firmware (store the key outside the repo, in `secrets.h`). |
| X9 | Protect against unauthorized attendance submissions | PC §14 | Key check first, then `DEVICE_DISABLED` (not active), `DEVICE_NOT_ASSIGNED`; `scan_id` must start with the device's own id | `submit-scans.test.js` "wrong key … nothing written", "a device in maintenance", "scan_id of another device"; `devices.test.js` "DEVICE_NOT_ASSIGNED" | MET | Server-only requirement. |
| X10 | Validate and sanitize user inputs | PC §14 | validators in every handler (`cleanText`, patterns, existence checks) | `users.test.js`, `cards.test.js`, `classes.test.js` | MET | `academic.js` validators were read but have no tests. |
| X11 | Do not expose the whole Sheet | PC §14 | Web App returns per-action data only | read `Server.gs` | PARTIAL | Sheet sharing settings are **UNVERIFIED** (not in the repo). |
| X12 | Use test data during development | PC §14 | `seed-data.json` (fake, `@example.com`) | `migration.test.js` "contains no passwords, hashes or google_sub" | MET | |
| X13 | UID alone is not strong identity | PC §14 | — | — | N/A | Design note. Device key + ScanLog review are the planned mitigations. |

### 1H. Login decisions (CLAUDE.md)

| # | Requirement | Source | Backend | Test(s) | Status | Notes |
|---|---|---|---|---|---|---|
| C1 | No Google Sign-In, no test sign-in | CL | removed from `Server.gs` / `actions.js` | `actions.test.js` "has no Google, test or demo sign-in actions"; `server-gs.test.js` "removed actions are unknown" | MET | |
| C2 | No demo mode | CL | — | `actions.test.js` same | MET | |
| C3 | Only admins create accounts (no sign-up) | CL | only `auth.login` / `auth.logout` are public | `actions.test.js` "auth actions: only login and logout are public" | MET | |
| C4 | Instructor/admin: username; student: student number | CL | `newUserRow`, `createStudent` | `users.test.js` (student / instructor / admin create) | MET | |
| C5 | Usernames trimmed, lowercase, unique across all users | CL | `normalizeUsername`, `usernameProblem` | `users.test.js` "usernames are unique across ALL roles, ignoring case" | MET | |
| C6 | Default password per role from Script Properties; missing → error | CL | `ctx.defaultPassword` | `users.test.js` "fails with NOT_CONFIGURED and changes nothing" | MET | Adds `DEFAULT_ADMIN_PASSWORD`. |
| C7 | Salt + pepper + iterated SHA-256, versioned string | CL | `passwords.js` | `passwords.test.js` (format, round-trip, pepper, salt) | MET | |
| C8 | One hash ≈ 200–500 ms in Apps Script | CL | `PASSWORD_HASH_ITERATIONS = 300` (`passwords.js:22`) | `passwords.test.js` "uses 300 iterations" | MET | 359 ms is computed from your 1500-run; re-run `benchmarkPasswordHash` to confirm. |
| C9 | Constant-time comparison | CL | `constantTimeEqual` (`passwords.js:72`) | `passwords.test.js` | MET | |
| C10 | Same error for wrong username / wrong password | CL | `account.js:52-56` | `auth.test.js` "gives the SAME error" | MET | |
| C11 | Lockout 5 failures → 15 min; success resets | CL | `account.js:58-80` | `auth.test.js` lockout tests (fake clock) | MET | |
| C12 | Disabled accounts rejected | CL | `account.js:84-88`, `session.js:47` | `auth.test.js` disabled tests | MET | |
| C13 | must_change → only me / changePassword / logout | CL | `actions.js:111-113` | `auth.test.js` gate tests | MET | |
| C14 | changePassword rules + revoke other sessions | CL | `account.changePassword` | `auth.test.js` (3 tests) | MET | |
| C15 | admin.resetPassword / admin.unlockUser | CL | `auth/admin-users.js` | `users.test.js` | MET | |
| C16 | Last active admin cannot be disabled or demoted | CL | `admins.setAdminStatus`; no role-change action | `users.test.js` "cannot be disabled", "no action can change a user's role" | MET | |
| C17 | AuditLog login events, never the password | CL | `account.js` `audit()` | `auth.test.js` | MET | |
| C18 | Bootstrap admin (editor-only) | CL | `createBootstrapAdmin` | `migration.test.js`, `server-gs.test.js` | MET | |
| C19 | Idempotent migration of the existing Sheet | CL | `migrateUsersToPasswordLogin` | `migration.test.js` "is idempotent"; `server-gs.test.js` | MET | |
| C20 | Hashed session tokens; LockService on writes | CL | `session.js`; `Server.gs:76-89` | `auth.test.js` "only the hash is stored"; `server-gs.test.js` lock tests | MET | |
| C21 | No fake success | CL | unknown → `UNKNOWN_ACTION`; errors are `AppError` | `auth.test.js` "rejects unknown actions" | MET | No stub actions exist. |

### Totals

| Status | Count |
|---|---|
| MET | 81 |
| PARTIAL | 2 |
| MISSING | 0 |
| WRONG | 0 |
| N/A | 2 |
| **Total** | **85** |

MET includes **MET (backend)** rows (22 of them): the server part is done and tested, and the row's Notes name what still remains (frontend page or ESP32 firmware). No firmware is in this repo yet.

---

## Part 2 — Logic review per feature

For every action I checked: input validation, role + ownership, data written, error codes, lock, edge cases
(empty data, inactive records, duplicates, Manila midnight).

### Checked and OK

| Area | What I checked | Evidence |
|---|---|---|
| Routing + roles | Unknown action → `UNKNOWN_ACTION`; `__proto__` / `toString` are not actions; role checked before running; must-change gate | `auth.test.js` sessions/roles tests |
| Lock | Every WRITE action locks (`Server.gs:76-83`); reads do not; busy → `SERVER_BUSY` (step 4d), nothing saved | `server-gs.test.js` lock tests |
| Read actions are read-only | All 25 READ actions leave the db unchanged, so skipping the save is safe | `verification.test.js` |
| Failed actions save nothing | `Server.gs:89` saves only on success; failed logins are the one deliberate exception (`:94`) | `server-gs.test.js` "full login flow" |
| Ownership | Instructor: `ownClass()` on every class/session action. Student: `linkedId()`, ignores IDs in the request | `portal.test.js` |
| Manila time | Date strings use Asia/Manila; 23:59:59 vs 00:00 lands on the right day; `dayCodeOf` uses the date string, not the server clock | `verification.test.js` |
| Duplicates | Usernames, student numbers, emails, UIDs, room codes, subject/program codes, terms (name + date overlap), class (term+subject+section), schedules (room / instructor / section overlap), enrollments | `users.test.js`, `cards.test.js`, `classes.test.js`; `academic.js` read |
| Inactive records | Can't assign a card to, or enroll, an inactive student; inactive instructor can't get a class; deactivation is blocked while things depend on the record (`IN_USE`) | `cards.test.js`, `classes.test.js`; `academic.js:37-52` read |

### Confirmed bugs

Each bug has a test in `backend/tests/verification.test.js` that runs, fails, and is marked `todo`.

| ID | Severity | Where | What goes wrong | How to reproduce |
|---|---|---|---|---|
| BUG-1 | **FIXED** (was Medium, data loss): corrections set `override_status/by/at/reason`; rows are never deleted; `effectiveStatus()` (`utils.js`) is used for every count | `portal.js:353-354` | Correcting a student to **Absent** deletes the Attendance row. The device's `scanned_at`, `scan_id`, `card_id`, `device_id` are gone. AuditLog keeps only `{"status":"present"}`. If a device later re-sends that `scan_id`, it would be recorded again. | Correct ATT-00001 (STU-0001, SES-0001) to absent → the row disappears (BUG-1 test). Known from audit ISS-07. |
| BUG-2 | **FIXED** (was Medium): a section change in `updateStudent` drops the old section's active classes (status `dropped`, never deleted; attendance kept) and joins the new section's (`enrollInSectionClasses`; a dropped row is reactivated, no duplicate), in the same save. Classes of other sections (irregular) are untouched. Response `enrollment_changes: {dropped, enrolled}` (class labels); the STUDENT_UPDATE audit row has `enrolled_classes` before/after. | `students.js` `updateStudent`, `classes.js` `dropSectionClasses` | Was: moving a student kept the old classes and did not add the new ones. | `section-change.test.js`, `verification.test.js` BUG-2, `server-gs.test.js` BUG-2 (one batch / nothing saved). |
| BUG-3 | **FIXED** (was Medium, blocked Step 4): `setClassStatus` now runs `scheduleClash` on every active slot before re-activating | `classes.js:215-220` | Re-activating a class does not re-check schedule clashes. While a class is inactive its slots are ignored (`classes.test.js` "ignores schedules of inactive classes"), so another class can take the room; re-activating then gives **two classes in one room at the same time**. The session engine can't decide which class a tap belongs to. | Deactivate CLS-0001, schedule a new class in RM-0001 MON 08:00-10:00, re-activate CLS-0001 → accepted (BUG-3 test). |
| BUG-4 | **FIXED** (was Low): the admin dashboard counts through `sessionCounts()` (portal.js) over the current roster, like every other view | `dashboard.js:23` | Admin dashboard counts Attendance of **dropped** students but divides by current enrollment → rate above 100% (seen: 1.5). The instructor portal filters by roster and is correct. | Everyone attends SES-0001, then drop STU-0003 → `attendance_rate` 1.5 (BUG-4 test). |
| BUG-5 | **FIXED** (was Low now, Medium later): `writeAudit` now uses `nextId()` (a `reduce` loop); tested with 200,000 rows | `utils.js:82` | `writeAudit` uses `Math.max(...allRows)`. In Node this crashes ("Maximum call stack size exceeded") at about 130,000 AuditLog rows; Apps Script's limit is similar but **UNVERIFIED**. Every login adds a row, so a busy year can reach it, and then **every write fails**. | AuditLog with 150,000 rows → RangeError (BUG-5 test). Fix: a simple loop instead of the spread. |
| BUG-6 | **FIXED** (was Low): correcting a student with **no** Attendance row to Absent "succeeded", wrote an audit row, and changed nothing | `portal.js` `instructorCorrectAttendance` | Now refused with `VALIDATION_ERROR` ("This student has no tap for this session. They are counted as absent automatically when the class ends."); nothing is written. Present/late for a no-row student still adds a manual row; absent on an existing row still uses the override. | `verification.test.js` BUG-6 tests (during + after the session; nothing written). |
| BUG-7 | **FIXED** in step 4c (was Low): a student with no record counted as absent while the session was still running | `sessions.js` `missingStatus` / `sessionPhase` | No record = `not_scanned` until the scheduled (or actual) end, `absent` after. Counts carry `not_scanned`; absent and rates never include it. Uses `ctx.now()`. | `verification.test.js` BUG-7, `portal.test.js` + `attendance-override.test.js` "BUG-7" tests. |
| BUG-8 | **FIXED** with BUG-1 (was Low): `status` / `source` of a device row are never changed | `portal.js:355-356` | A correction overwrites the device-created row (`source` stays `device`, status changes). AR §7.2 item 4 says device rows are never edited in place; the original result survives only in AuditLog. | Correct ATT-00001 present → late → device row now says late (BUG-8 test). |

**Intentional change (2026-11-20, branch `admin-attendance`):** an explicit override to **absent** now counts as **absent at once**, even while the session is still running, in every view (instructor + admin dashboards, session view, reports, student portal, admin report). Before, the dashboards and session counts showed it as `not_scanned` until the session ended. `not_scanned` is now only for enrolled students with **no** Attendance row. One rule in `sessionCounts()` / `statusOf()` (`portal.js`); `admin-attendance.test.js` "one counting rule for every view" checks that all views agree.

### Design risks (not bugs, but you should decide)

| ID | Risk | Evidence | Suggestion |
|---|---|---|---|
| R1 | **High: taking over accounts that haven't signed in yet.** All new students share one default password, and their username is their student number (easy to guess). Anyone who knows the default can sign in first and choose the password, and the lockout doesn't help, because the first try is correct. | `migration.test.js` "migrated users can sign in with the role default" | Before real students: give each account a random one-time password that admins hand out, or have the first login done in front of the admin. Approved design, so your call. |
| R2 | **Medium: anyone can fill the AuditLog and hold the write lock.** `auth.login` is public; every failed attempt (even an unknown username) takes the script lock, reads the whole Sheet and writes an AuditLog row. A script sending many wrong logins slows everyone down and speeds up BUG-5. | `auth.test.js` "marks failed logins to be saved (commit) and audits them" | Don't audit unknown usernames, or count them in CacheService (no Sheet write). |
| R3 | **Step 4: request time and the one write lock.** Fixed in code (step 4a): each action loads only its declared tabs (one `values.batchGet`) and saves in one `spreadsheets.batchUpdate`; append tabs load only header + last row. Writes still share one lock (`LOCK_WAIT_MS` 10 s → `SERVER_BUSY`). | `tabs.test.js`; `tools/measure_device_api.mjs`; live Web App 2026-11-20: ~2.3–3.7 s per request, up to ~13 s with 10 at once (`Device_API_Spec.md` §3.2) | **Still UNVERIFIED:** 40 taps in 2 minutes on a term-sized Sheet. The device queue + `SERVER_BUSY` retry covers short bursts. |
| R4 | **Resolved:** `submitScans` creates the ClassSession on the first tap (one per schedule + date, `resolveScan` in `sessions.js`); a session counts as ended once its end time passes (`sessionPhase`, computed when reading, no trigger). | `sessions.test.js`; `submit-scans.test.js` "two students first-tapping an unopened session share ONE new session" | Still open: manual start/extend/cancel by the instructor (AR §4.4). Nothing sets `status = closed`, by design. |

### Smaller notes (no action needed now)

- `student.getHistory` only lists classes the student is **still** enrolled in (`portal.js:486-490`). After a drop, they can't see their past attendance for that class. Probably fine; confirm.
- `historyRows` filters `status !== 'scheduled'` (`portal.js:499`), but no session ever has that status. Dead condition.
- A room can't be deactivated while an **inactive** class still has active slots in it (`academic.js:358`).

### Known limitations

- After a section change, a dropped student's past taps still exist (`admin.listAttendance`) but are not counted in the old class's report totals. Future: enrollment date ranges.

---

## Part 3 — Data model check

I compared the 19 seed tabs (= `setupSheets` columns) with what `backend/src` reads/writes and with AR §5.4.

| Tab | Matches AR §5.4? | Columns the code never reads | Notes (after Step 4) |
|---|---|---|---|
| Users | Newer than AR (AR still shows `google_sub`, no passwords; **doc out of date**) | — | OK. |
| AuthSessions | Yes | — | OK. |
| Students, Instructors, Programs, Sections, Subjects, Terms, Rooms | Yes | — | OK. |
| RfidCards | Yes | — | OK. `roster_version` is bumped on every card change (`cards.test.js`) and read by `device.getRoster`. |
| **Devices** | Yes | — | Used by device auth, `heartbeat` and the admin device actions (step 4b/4e). The heartbeat's `uptime_seconds` is validated but has no column (optional). |
| Classes | Yes | — | `late_grace_minutes` is only stored/displayed: a tap is always PRESENT (decision, see CLAUDE.md). |
| Schedules | Yes | — | OK. BUG-3 fixed; `listScheduleClashes` reports old clashes. |
| Enrollments | Yes | — | OK. BUG-2 fixed (a section change moves enrollments). |
| **ClassSessions** | Yes | `opened_by`, `closed_by` | Created by `submitScans` on the first tap, one per (schedule_id, session_date) (`resolveScan`). Ended = computed from the time (`sessionPhase`). |
| Attendance | Yes | — | OK. Unique (session_id, student_id) → `DUPLICATE`; unique `scan_id` → `ALREADY_RECORDED`; `scanned_at` stored as Manila ISO (`submit-scans.test.js`). |
| **ScanLog** | Yes | — | Written for every tap by `submitScans`; `scan_id` lookup gives `ALREADY_RECORDED`. Still no **`time_quality`** column (stored on Attendance rows only, so an `INVALID_TIME` scan's reason is not kept) and no `card_id`. |
| AuditLog | Yes | — | BUG-5 FIXED. Step 4a: write actions load only its header + last row; the portals no longer read it (correction reasons are in `Attendance.override_reason`). |
| **Settings** | Yes (+2 login keys) | not read: `late_grace_minutes` (kept, unused by decision) | `early_window_minutes`, `accept_after_end_minutes` → `sessions.js`; `duplicate_window_minutes`, `heartbeat_interval_seconds` → `device.getRoster`; 10 keys editable via `admin.updateSettings`. `allowed_email_rule` removed (correct). |

Missing tables: none. Step 4 is built on this schema. Only open column gap: ScanLog `time_quality` (and `card_id`).

---

## Part 4 — Gap list for Step 4

Goal: **student taps RFID → attendance is saved under the right class session → it shows in the portals.**
Status re-checked 2026-11-20 against `backend/src` and the tests. The server side of this goal is **done**;
what remains is the frontend pages, the ESP32 firmware, and the items marked OPEN below.

| # | Build this | Status | Evidence / what remains |
|---|---|---|---|
| 1 | Fix **BUG-3** (re-activate checks room clashes) and **BUG-5** (loop instead of spread) | DONE | Part 2, Confirmed bugs. |
| 2 | **Devices admin actions**: list, create, key shown once (hash stored), new key, retire; one active device per room | DONE (backend) | `admin.*Device*`, `devices.test.js`. Remains: frontend devices page. |
| 3 | **Device auth**: `device_id` + `device_key`, `INVALID_DEVICE_KEY` / `DEVICE_DISABLED` / `DEVICE_NOT_ASSIGNED` | DONE | `authenticateDevice`, `devices.test.js`. |
| 4 | **Session engine** (pure): device → room → class slot with `early_window` / `accept_after_end`, one ClassSession per schedule + date, `SESSION_CANCELLED` | DONE, except manual sessions | `sessions.js` `resolveScan`, `sessions.test.js`. A tap is always PRESENT (decision). OPEN: manual start/extend/cancel (AR §4.4). |
| 5 | **`device.submitScans`** (1–20 scans, epoch → Manila ISO, `INVALID_TIME`, `ALREADY_RECORDED`, `NOT_ENROLLED`, `DUPLICATE`, Attendance + ScanLog, `lcd_line2`) | DONE | `submit-scans.test.js`. ScanLog has no `time_quality` column (Part 3). |
| 6 | **`device.heartbeat`** → Devices, returns `low_battery` | DONE | `heartbeat-roster.test.js`; `server-gs.test.js` (one row, no AuditLog). |
| 7 | **`device.getRoster`** (only when `roster_version` changed) | DONE | `heartbeat-roster.test.js`. |
| 8 | **Session closing** so absences count | DONE | Computed when reading (`sessionPhase` / `missingStatus`), no trigger; `verification.test.js` BUG-7. |
| 9 | **End-to-end test**: tap → `instructor.getSession` → `student.getHistory` | DONE | `submit-scans.test.js` "tap -> instructor.getSession …"; Server.gs path in `server-gs.test.js`. |
| 10 | **Speed check in real Apps Script** | PARTIAL | Declared tabs + one batchUpdate (step 4a); live 2.3–3.7 s per request (`Device_API_Spec.md` §3.2); live device test `tools/live_device_test.mjs`. OPEN: 40 taps in 2 minutes on a term-sized Sheet (R3). |
| 11 | Fix **BUG-1, BUG-2, BUG-6, BUG-7, BUG-8**; decide R1 | DONE | Part 2. R1 decided: a random temporary password per account (CLAUDE.md). |
| 12 | After the MVP: manual sessions (AR §4.4), admin reports, admin settings, admin corrections (D6), student date filter (S5) | Backend DONE except manual sessions | `admin.getAttendanceReport`, `admin.updateSettings`, `admin.correctAttendance`, date filters. OPEN: manual sessions (backend) and every frontend page. |
