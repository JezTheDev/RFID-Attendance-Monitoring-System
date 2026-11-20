# Final Backend Review (before the frontend phase)

| | |
|---|---|
| Date | 2026-11-20 |
| Branch | `final-backend-review` (from `main` @ `ca67241`) |
| Type | **Read-only.** No code, test or Sheet was changed. Nothing was deleted. |
| Baseline | `npm test` → **565 tests, 565 pass, 0 fail, 0 todo** |
| Method | Read all of `backend/src` + `Server.gs`, plus a separate reviewer pass over every action. Suspected gaps were reproduced in Node with the test helpers (the throwaway script was deleted afterwards). |
| Not checked | The live Apps Script / Sheet (speed, sharing, quotas). Firmware (not in the repo). |

## Verdict: safe to start the frontend? **YES**

Walang Critical. Roles, ownership (`linked_id` from the session), the lock on every write, hashed tokens and device keys, and the all-or-nothing save all hold. No response or AuditLog row leaks a hash or secret. The Important items below are small backend fixes (S) or decisions. None of them change the API shape the frontend will use, so the frontend can start in parallel. **Fix I1 and decide I2/I3 before go-live with real students.**

---

## 1. The 11 PARTIAL rows

Source: `docs/BACKEND_VERIFICATION.md` at commit `0e3dd49` (11 PARTIAL). Commit `ca67241` re-checked them: 9 are now **MET (backend)**, 2 are still PARTIAL.

| # | Row | Now | What is still missing | Where | Backend effort |
|---|---|---|---|---|---|
| 1 | F3 Accurate timestamping | MET (backend) | Device clock: NTP sync; send `time_quality` / epoch `scanned_at` | Firmware | — |
| 2 | F8 Low-battery monitoring | MET (backend) | Measure the battery and send `device.heartbeat`; admin devices page | Firmware + Frontend | — |
| 3 | A5 View all attendance records | MET (backend) | Admin attendance page over `admin.listAttendance` | Frontend | — |
| 4 | A7 Monitor device status | MET (backend) | Admin devices page (list/create/key/status/room) | Frontend | — |
| 5 | D8 Admin device monitoring | MET (backend) | Same as A7 (the dashboard already gets `devices[]`) | Frontend | — |
| 6 | **D12 Instructor recent activity** | **PARTIAL** | No "recent taps" feed for the instructor's classes. `instructor.getDashboard` only has the sessions of one date. | **Backend** + Frontend | **S**: add `recent` (last ~10 Attendance rows of own active classes) to `instructor.getDashboard`, reusing `recordOf`/`effectiveStatus` |
| 7 | L2 Duplicate prevention (configurable) | MET (backend) | Enforce the `duplicate_window_minutes` cooldown on the device | Firmware | — |
| 8 | L3 Timestamping Asia/Manila | MET (backend) | NTP on the device | Firmware | — |
| 9 | L6 Dashboard device status + battery | MET (backend) | Heartbeats from the device; devices page | Firmware + Frontend | — |
| 10 | L7 Pending offline vs synced | MET (backend) | Device sends `sync_mode` / `queue_count`; pages show them | Firmware + Frontend | — |
| 11 | **X11 Don't expose the whole Sheet** | **PARTIAL** | The Sheet's sharing settings can't be checked from the repo. Keep the Sheet private (owner = project account only); the Web App runs as the owner. | Deployment (manual check) | — (no code) |

Other open items (not among the 11): **manual sessions** (AR §4.4: start/extend/cancel by the instructor), backend effort **M**, still OPEN. And Part 4 #10 **speed**: 40 taps in 2 minutes on a term-sized Sheet is still UNVERIFIED live.

---

## 2. Findings by severity

### Critical

None.

### Important

**I1. A reactivated student or instructor gets their old session token back.** (CONFIRMED, reproduced)
- **Where:** `backend/src/handlers/students.js:239-272` (`setStudentStatus`) and `backend/src/handlers/instructors.js:95-115` (`setInstructorStatus`). Both set `Users.account_status` but never revoke `AuthSessions`, and neither declares that tab (`actions.js:71-72`, `:135-136`). `setAdminStatus` does revoke (`admins.js:93-96`).
- **Reproduce:**
  1. A student signs in → token T.
  2. The admin runs `admin.setStudentStatus {inactive}`. T now gives `NOT_SIGNED_IN` (correct).
  3. The admin runs `admin.setStudentStatus {active}` within `session_token_hours` → **T works again** (`student.getProfile` ok). The AuthSessions row still says `revoked: FALSE`.
- **Why it matters:** "deactivate because the phone was stolen, reactivate later" silently re-opens the stolen session.
- **Fix (S):** call `revokeSessions(db, user.user_id)` on deactivation, and add `AuthSessions` to `writes` of both actions. Add one test per action.

**I2. There is no production setup path: `setupSheets` is the only way to create the tabs, and it fills them with FAKE data.**
- **Where:** `backend/apps-script/Server.gs:549-580`.
- **Reproduce:** on a fresh real Sheet, run `createBootstrapAdmin` first. That creates `Users` with 1 row. Then run `setupSheets`. Because `Users` is no longer empty, the `TEST_SEED_PASSWORD` check (`:553-557`) is skipped, and every other empty tab gets the **fake students, instructors, classes, attendance**.
- **Also:**
  - Without `setupSheets`, the `Settings` rows (incl. `roster_version`) never exist. `bumpRosterVersion` (`utils.js:22-25`) is then a silent no-op, and devices never download a roster. Reproduced: `admin.revokeCard` with no `roster_version` row leaves it missing.
  - Tabs created on the fly by `saveDb_` get no plain-text (`@`) format.
- **Fix (S):** see §3, items P1-P3.

**I3. An instructor can still read and correct attendance of an INACTIVE class.** (decision needed)
- **Where:** `ownClass` (`portal.js:164-170`) checks only `instructor_id`, not `status`. `correctAttendance` (`portal.js:372-388`) has no class-status or term check.
- **Reproduce:** the admin runs `admin.setClassStatus {CLS-x, inactive}`. The instructor then sends `instructor.correctAttendance {session of CLS-x, student, present, reason}` → `ok:true`, and the row is changed and audited. Lists hide the class (`myClasses`), but a direct `class_id` / `session_id` works.
- **Fix (S):** decide. Recommended: reads stay allowed (old reports); corrections refused with `CLASS_INACTIVE`. The admin correction stays allowed.

### Minor

| ID | Finding | Where | How to reproduce | Fix |
|---|---|---|---|---|
| M1 | Free-text fields have no max length (correction / status / revoke / drop `reason`, device `notes`, `firmware_version` in submitScans) | `portal.js:378`, `students.js:243,333`, `classes.js:347`, `devices.js:76,83-89`, `device.js:125` | Send a 60,000-character reason → the Sheets 50,000-character cell limit makes `batchUpdate` fail → `SERVER_ERROR` (nothing saved, but noisy) | Cap at ~500 characters (32 for `firmware_version`, like heartbeat) |
| M2 | Offline scans are matched against the device's **current** room | `device.js:72` | Device queues taps in room A → admin `assignDeviceRoom` to B → the sync matches B's schedule → `NOT_ENROLLED` or the wrong class | Refuse a room change for an active device (put it in maintenance first) or while `queue_count > 0` |
| M3 | Whoever holds a device key can add attendance for any past day of the active term | `sessions.js:42` (term check only) | `submitScans` with `scanned_at` = 2 months ago, `time_quality: backfilled` → ACCEPTED | Max age (e.g. 7 days), or flag old scans for review |
| M4 | `auth.login` is public, takes the write lock (~360 ms hash) and writes an AuditLog row even for unknown usernames (R2, still open). Student usernames are guessable, so anyone can lock an account | `account.js:54-60`, `actions.js:43` | Loop wrong logins → lock contention / `SERVER_BUSY` for devices; the target account is locked for `lockout_minutes` | Accept + document (the admin unlock button), or don't audit unknown usernames |
| M5 | A correction is allowed on a session that has not started (an early tap creates an `open` session) | `portal.js:372` | Tap 10 min early → the instructor marks others present before class | Refuse when `sessionPhase === 'upcoming'` |
| M6 | Reports count only currently enrolled + active students, so dropping or deactivating changes past numbers, and the student loses the history of a dropped class | `portal.js:56-61`, `:550-554` | Drop a student who was absent → the class rate goes up | Decide (known limitation in BACKEND_VERIFICATION) |
| M7 | Email uniqueness is case-sensitive for students and instructors, case-insensitive for admins | `students.js:164`, `instructors.js:61` vs `admins.js:37` | An old mixed-case email in Users doesn't clash | Lower-case both sides |
| M8 | `View - Attendance` shows the DEVICE status, not the corrected one, and says "absent students have no row" (false since BUG-1) | `Server.gs:622`, `:640` | Correct a present row to absent → the View still says Present | Use `IF(override_status<>"", override_status, status)`; fix the note |
| M9 | `updateDevice` works on a retired device (the other device actions refuse) | `devices.js:83-89` | Rename a retired device → ok | Add `notRetired(device)` (or accept: only the name/notes change) |
| M10 | Dead condition: no session ever has status `scheduled` | `portal.js:562` | — | Delete the condition |
| M11 | `CLAUDE.md` contains a raw NUL byte (the device hash line), so `grep` treats it as binary; it reads like `pepper + " " + key` | `CLAUDE.md:147` | `grep -c x CLAUDE.md` → "Binary file matches" | Write it as `` `pepper + "\u0000" + key` `` |
| M12 | Stale docs: `CLAUDE.md` calls `docs/AUDIT_REPORT.md` "current state" (it is from 2026-11-18, demo era); BACKEND_VERIFICATION row C6 still says "default password per role" | `CLAUDE.md:6`, `BACKEND_VERIFICATION.md:163` | — | See §4 (archive) and update the pointer / row |

### Checked and OK (gaps between features)

- **Disabled user:** `authorize` rejects any non-active user at once (`session.js:47`). Admin deactivation, password reset and changePassword revoke sessions. The only gap is reactivation (I1).
- **Retired device:** the key is cleared → `INVALID_DEVICE_KEY`. Maintenance → `DEVICE_DISABLED`. A new key kills the old one at once. One active device per room. A room can't be deactivated while a device is assigned.
- **Dropped / inactive student:** the server refuses the scan even if the device roster is stale (`NOT_ENROLLED` / `UNREGISTERED`). Deactivation revokes the card and bumps `roster_version`.
- **Inactive class:** no new attendance from taps (`resolveScan` requires an active class in the active term). Re-activation checks clashes (BUG-3).
- **Instructor moved off a class:** loses all access, corrections included (`ownClass`).
- **Settings:** all-or-nothing, range-checked, `__proto__`-safe. Roster keys bump `roster_version`.
- **Last admin:** an admin can't deactivate themselves or the last active admin.
- **Tabs:** `tabs.test.js` passes for every action. Every WRITE action locks (`server-gs.test.js`).
- **No fake success:** BUG-6 is fixed. No stub actions exist.

---

## 3. Production readiness (REAL Sheet, no fake data)

What exists today: `createBootstrapAdmin`, `checkSetup` (warns about the pepper, the bootstrap password, `roster_version`, `low_battery_voltage`), `benchmarkPasswordHash`, and the Admin portal device keys.

| # | Missing piece | Where | Effort |
|---|---|---|---|
| P1 | **`setupEmptySheets()`**: creates every tab (names + headers from `SEED_DATA` / `AUTH_SESSION_HEADERS`), plain-text `@` format, frozen header, **no fake rows**. Refuses if any data tab already has rows. | `Server.gs` | S |
| P2 | It also writes the **default Settings rows** (configuration, not people): the 12 keys from the seed, incl. `roster_version = 1`, `low_battery_voltage = 3.5`, `max_login_attempts`, `lockout_minutes`, `temp_password_days`. Optional: also run `setupViews()`. | `Server.gs` | (part of P1) |
| P3 | **Guard `setupSheets`:** always require `TEST_SEED_PASSWORD`, not only when `Users` is empty (closes I2's fake-data trap) | `Server.gs:553-557` | S |
| P4 | `checkSetup` prints whether this is a TEST Sheet (`TEST_SEED_PASSWORD` set). On production it must say **not set**. | `Server.gs:658` | S |
| P5 | Fresh **`PASSWORD_PEPPER`** for production (never the TEST one). Docs only: e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` → Script Properties. Never change it after the first user. | `backend/README.md` | S (docs) |
| P6 | First admin: `BOOTSTRAP_ADMIN_*` → `createBootstrapAdmin` → delete `BOOTSTRAP_ADMIN_PASSWORD`. **Exists**; just put it in the production checklist, after P1. | — | — |
| P7 | A separate production Apps Script project + Web App deployment. Frontend `config.js` `API_URL` must point to it (today it points to the current deployment). | ops + `frontend/assets/js/config.js` | S |
| P8 | Sheet sharing private (X11). Web App stays `USER_DEPLOYING` / `ANYONE_ANONYMOUS` (needed for devices + the browser; auth is in the code). | ops | — |
| P9 | Live speed check on a term-sized Sheet (R3) and the 4f live device test against production keys. | ops | — |
| P10 | School approval before real student data (PC §14). | team | — |

**Production order (once P1-P4 exist):** new Sheet + script → Script Properties `PASSWORD_PEPPER` (new) → `setupEmptySheets` → `BOOTSTRAP_ADMIN_*` → `createBootstrapAdmin` → delete `BOOTSTRAP_ADMIN_PASSWORD` → `benchmarkPasswordHash` + `checkSetup` → Deploy → admin creates terms/rooms/devices/people in the portal.

Note: the **column schema lives in `seed-data.json`** (`defaultHeaders_` uses the first seed row of each tab). Keep at least one seed row per tab, or move the headers into a constant when P1 is built.

---

## 4. Unused code / files

"Callers" = grep over `backend/src`, `backend/apps-script/Server.gs`, `backend/tests`, `frontend`, `tools`, `docs`, READMEs. Generated `Bundle.gs` / `SeedData.gs` are excluded.

| Item | Proof (who references it) | Recommendation |
|---|---|---|
| `docs/RFID_Test_Data.xlsx` | Only `tools/xlsx_to_seed_data.py`, `backend/README.md`, `docs/AUDIT_REPORT.md`, `docs/RFID_Attendance_System_Architecture.md` (prose). No code reads it. `seed-data.json` has been edited by hand since (BUG-1, temp passwords), so the xlsx is out of sync. | **DELETE** (team: seed-data.json is the only source). Update the 3 doc mentions. |
| `tools/xlsx_to_seed_data.py` | Only `README.md`, `backend/README.md`, 2 old superpowers docs. Not in tests or the build. Re-running it would overwrite the newer seed JSON. | **DELETE** with the xlsx. |
| `migrateUsersToPasswordLogin` (`Server.gs:197`, `auth/migration.js:33`) + `dropEmptyColumn_` (`Server.gs:276`, only caller is the migration) | Server.gs; `migration.test.js`, `server-gs.test.js`; `backend/README.md`; CLAUDE.md step 5 | **KEEP until** the existing deployed (Google-era) Sheet has been migrated, then **DELETE** both + their tests. A fresh production Sheet never needs them. |
| `backfillOverrideReasons` (`Server.gs:213`, `maintenance.js:11`) | Server.gs; `maintenance.test.js`, `server-gs.test.js`; CLAUDE.md step 7 | **KEEP until** run once on the deployed Sheet (step 4a), then **DELETE**. Production has no old corrections. |
| `benchmarkPasswordHash` (`Server.gs:297`) | Server.gs; `backend/README.md`; CLAUDE.md step 7 | **KEEP**: 15 lines, the only way to re-tune `PASSWORD_HASH_ITERATIONS` on the real runtime. |
| `listScheduleClashes` / `findScheduleClashes` | Server.gs; `maintenance.test.js`, `live-test.test.js`, `server-gs.test.js` | **KEEP**: read-only health check, also useful after hand edits. |
| `late_grace_minutes`: Settings row | Hidden from `admin.getSettings` (`settings.js`); no code reads the value | **KEEP the row** (deleting Sheet rows by hand is riskier than leaving it). Already documented as unused. |
| `late_grace_minutes`: `Classes` column + `graceValue` in `createClass`/`updateClass` (`classes.js:138-146`) + frontend field "Late after (minutes)" (`frontend/assets/js/pages/admin-classes.js:225,279-281`) | Stored and validated, **never used** (a tap is always PRESENT) | **DELETE** the frontend field (it misleads admins) and stop accepting it in `createClass`/`updateClass`. **KEEP** the Sheet column (old rows). |
| `ClassSessions.opened_by`, `closed_by` | Written as `''` (`sessions.js:96-97`), never read | **KEEP**: planned for manual sessions (AR §4.4). |
| `ClassSessions.actual_start/actual_end` | Read by `sessions.js` / `portal.js`; only manual sessions would set them | **KEEP** (manual sessions). |
| `status !== 'scheduled'` filter | `portal.js:562`; no session is ever `scheduled` | **DELETE** the condition (M10). |
| `backend/src/config.js` (`TIMEZONE`) | Exported and bundled; **nothing reads `TIMEZONE`** (Manila is a fixed +8 h in `utils.js`) | **DELETE** (optional, tiny): remove from the build list + CLAUDE.md. Or KEEP as documentation. |
| Export-only names (`DEVICE_STATUSES`, `USERNAME_PATTERN`, `findUserByUsername`, `recordOf`, `statusOf`, `summarize`, `DEVICE_TABS`, `AUTH_TABS`) | Used inside their own module; the export itself has no importer (some are used by tests) | **KEEP**: harmless. |
| `OBSOLETE_PROPERTIES` warning in `checkSetup` | Server.gs:34, :665 | **KEEP** until the deployed Sheet's old properties are deleted; then optional delete. |
| Test/editor tools: `seedTestPasswords`, `issueTestDeviceKey`, `prepareLiveTest`, `cleanupLiveTest`, `tools/live_device_test.mjs`, `tools/measure_device_api.mjs`, `tools/measure_admin_reports.mjs`, `setupViews`, `checkSetup` | Server.gs, tests (`live-test`, `live-device-tool`, `devices`, `server-gs`), backend/README | **KEEP**: TEST-Sheet tools (gated by `TEST_SEED_PASSWORD`) and the measurement tools that back the speed numbers. |
| `backend/seed/seed-data.json` | Build → SeedData.gs; `setupSheets`; `defaultHeaders_` (the column schema); tests | **KEEP**: it is also the header schema (see §3 note). |
| Demo CSS: `.demo-roles`, `[data-demo-role]` | `frontend/assets/css/app.css:1478-1479`, `frontend/assets/css/auth.css:620, 982-996`; **no** HTML/JS uses `demo` | **DELETE** in the frontend phase. |
| Google mentions | Only prose ("Google Sheet", "Google Apps Script"), the migration comments about `google_sub`, the obsolete-property names, and old docs. No Google Sign-In code is left (`actions.test.js` "has no Google, test or demo sign-in actions"). | Nothing to delete in code; handled by the archive below. |
| `docs/AUDIT_REPORT.md` | CLAUDE.md:6 (as "current state"); content is from 2026-11-18 (demo handlers, ~40% done, default passwords) | **ARCHIVE** → `docs/archive/`; point CLAUDE.md to `BACKEND_VERIFICATION.md` + this file. |
| `docs/superpowers/plans/*` (12) + `docs/superpowers/specs/*` (5) | Only each other, CLAUDE.md-style notes and BACKEND_VERIFICATION evidence; all implemented | **ARCHIVE** → `docs/archive/superpowers/`. |
| `docs/RFID_Attendance_System_Architecture.md` | Cited as "AR §…" everywhere (manual sessions §4.4, rule 7.2) | **KEEP**, but §5.4 Users (`google_sub`, no passwords) is out of date: update or add a "superseded by CLAUDE.md" note. |
| `docs/BACKEND_VERIFICATION.md`, `docs/Device_API_Spec.md`, `docs/PROJECT_CONTEXT.md` | Current sources | **KEEP** (fix row C6, M12). |

Nothing was deleted or moved in this task.

---

## 5. Suggested order

1. **Before go-live (backend, all S):** I1, P1-P4, decide I3, D12 `recent` feed, M8.
2. **Frontend phase:** admin devices / settings / attendance + report / correction pages, student date filter, account settings + admin reset/unlock (Step 3). Drop the `late_grace_minutes` field and the demo CSS.
3. **Cleanup PR (after the deployed Sheet is migrated):** the DELETE / ARCHIVE rows of §4.
4. **Later:** manual sessions (M), M1-M7, live speed test.

---

## 6. Wrap-up status (branch `backend-wrapup-fixes`)

Tests for all of these are in `backend/tests/wrapup-fixes.test.js`.

| Item | Status |
|---|---|
| I1 | **FIXED**: deactivating a student or instructor revokes all their AuthSessions (as for admins); `AuthSessions` is declared in `writes`. |
| I3 | **FIXED**: `instructor.correctAttendance` on an inactive class → `CLASS_INACTIVE`, nothing written; reads stay allowed; admin correction still works. |
| D12 | **FIXED**: new READ action `instructor.getRecentActivity {class_id?, limit?}` (own classes only, newest first, `limit` default 20 / max 50, `has_more`). |
| M1 | **FIXED**: reasons and device notes max 500 characters (`MAX_TEXT`). A bad `firmware_version` in `submitScans` is ignored (the scans are still saved). |
| M5 | **FIXED**: corrections on a session that has not started → `SESSION_NOT_STARTED` (instructor and admin). |
| M7 | **FIXED**: email uniqueness ignores case for students and instructors. |
| M8 | **FIXED (needs a live check)**: `View - Attendance` Status = override if set; note text updated. Formulas are not unit-tested: re-run `setupViews` on the TEST Sheet and look. |
| M9 | **FIXED**: `updateDevice` on a retired device → `DEVICE_RETIRED`. |
| M10 | **FIXED**: the dead `scheduled` condition is removed. |
| M11 | **FIXED**: the NUL byte in CLAUDE.md is gone (the file is now normal text in git, so this one commit shows a whole-file line-ending change). |
| M12 | **FIXED**: the CLAUDE.md pointer and BACKEND_VERIFICATION rows C6 and D12 are updated. Archiving the old docs is left for the cleanup PR. |
| M2 | LEFT: needs a device-ops rule (refuse a room move with a queue / while active); it changes admin workflow. |
| M3 | LEFT: a max scan age is a product decision; it could drop legitimate offline backfill. |
| M4 | LEFT: design trade-off (public login + lockout); no cheap fix without CacheService/rate limiting. |
| M6 | LEFT: historical enrollment for reports is a design change (M effort). |
| I2 / P1-P4 | LEFT: production setup (`setupEmptySheets`, `setupSheets` guard); not in this task's scope. |

## 7. Production setup + cleanup status (branch `backend-production-cleanup`)

| Item | Status |
|---|---|
| I2 / P1-P2 | **DONE**: `setupEmptySheets()` (every tab + columns from `backend/src/schema.js`, default Settings incl. `roster_version = 1`, View tabs, no fake data, idempotent, refuses on a TEST Sheet). Production needs no `SeedData.gs`. |
| P3 | **DONE**: `setupSheets()` always requires `TEST_SEED_PASSWORD`. |
| P4 | **DONE**: `checkSetup()` first line `Environment: TEST` / `Environment: PRODUCTION`. |
| P5-P8 | **DONE (docs)**: `docs/PRODUCTION_SETUP.md`. P9 (live speed test) and P10 (school approval) are still open. |
| §4 DELETE rows | **DONE**: xlsx + converter, "Late after" field, demo CSS, `migrateUsersToPasswordLogin` (+ `dropEmptyColumn_`), `backfillOverrideReasons`, `late_grace_minutes` (schema, seed, class actions; an older Sheet's data is ignored). |
| §4 ARCHIVE rows | **DONE**: `docs/archive/AUDIT_REPORT.md`, `docs/archive/superpowers/`. |

Sections 1-5 above are the review as written on 2026-11-20; file paths there may now be in `docs/archive/` or deleted.
