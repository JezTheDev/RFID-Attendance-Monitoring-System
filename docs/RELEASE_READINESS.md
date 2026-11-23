# Release readiness — final test (2026-11-24)

Branch `release-check` (from `main` @ 6dfde36). Live API = the TEST Sheet Web App
in `frontend/assets/js/config.js`. QA/fake data only. Secrets stayed in memory
(the scenario script masked every known secret before printing; a final grep of the
log found none).

**Verdict: NO-GO** — until the TEST/production Web App is redeployed with the
current code. Details and the short list to reach GO are at the end.

---

## 1. Automated checks

| Check | Result | Time |
|---|---|---|
| `npm test` (before fix) | 620 / 620 pass | 6.6 s |
| `npm test` (after fix, final) | **621 / 621 pass** (1 new test) | ~7 s |
| `node tools/build_apps_script.mjs` | OK, 25 modules; committed `Bundle.gs` = fresh build (only date + whitespace differ) | <1 s |
| Design checker FULL (19 pages × 7 widths × 3 engines = 399 page loads) | see below | 88 s |

**Design checker note.** `tools/check_layout.mjs` lives on the unmerged `redesign`
branch. It was copied in temporarily (not committed) and run against `main`'s frontend.
That checker blocks every non-local host (the redesign vendors Bootstrap), but
`main` loads Bootstrap from jsDelivr, so the first run (83 s) was all noise (Bootstrap
missing → 324 horizontal-scroll, 511 console errors). Second run with jsDelivr allowed:

| Check | Count | What it is |
|---|---|---|
| touch_emulation | 0 | |
| horizontal_scroll | **3** | `student/history.html` @320 px, all 3 engines (341 > 320) |
| console_errors | 133 | all `ERR_FAILED` = Google Fonts `@import` blocked by the harness (artifact) |
| touch_target | 1731 | small buttons/links < 44 px (menu buttons, `btn-sm`, user chip) |
| input_font_size | 76 | inputs < 16 px (iOS zooms on focus) |
| input_label | 0 | |
| reduced_motion_animations | 9 | login fade-in ignores `prefers-reduced-motion` |
| not_yet_wrap | 0 | |
| load_errors | 0 | |

All of these are the known "redesign not done" items (fixed on `redesign`); none
breaks a function. Not blockers.

---

## 2. Full scenario on the LIVE API (run 3, 61 checks: 58 PASS, 3 FAIL)

One story, all roles. QA codes `QA-REL3` (room, section, subject), device
`DEV-QA-REL3-01`, class `CLS-0011` for `instructor01.test`, schedule TUE now−5 →
now+20, QA student `9999850xxx` + seeded `9999000009` (A, taps) and `9999000005`
(B, never taps); `9999000001` (C) = not enrolled. UI steps = real frontend served on
localhost, Chromium, signing in through the real login form against the live API.

Runs 1 and 2 stopped early on **mistakes in my test script** (wrong response key
`items`/`rows`, alert matched by id instead of name, a URL wait that treated
`/instructor/index.html` as the login page). Both cleaned up fully (`QA-REL`,
`QA-REL2` left inactive/retired). Their passed steps match run 3.

| # | Step | Expected | Got | |
|---|---|---|---|---|
| 1 | admin.createStudent (QA) | ok + temp_password once | STU-0020, temp_password present | PASS |
| 2 | admin.assignCard | ok | ok | PASS |
| 3 | createRoom + createDevice + generateDeviceKey + activate | key 64 hex once, active | DEV-QA-REL3-01, 64 hex, active | PASS |
| 4 | createClass (instructor01) + schedule now−5..now+20 + enroll | QA auto-enrolled + 2 added | enrolled=1, added=2 | PASS |
| 5 | device.getRoster | changed, has QA UID | changed=true, 14 cards | PASS |
| 6 | tap QA card (live) | ACCEPTED | ACCEPTED | PASS |
| 7 | tap again | DUPLICATE | DUPLICATE | PASS |
| 8 | unknown UID | UNREGISTERED | UNREGISTERED | PASS |
| 9 | offline batch of 3 (A, QA, C) | ACCEPTED, DUPLICATE, NOT_ENROLLED | same | PASS |
| 10 | retry batch item A (same scan_id) | ALREADY_RECORDED (+ original ACCEPTED) | same | PASS |
| 11 | heartbeat 3.21 V | low_battery true | true | PASS |
| 12 | wrong device key | INVALID_DEVICE_KEY | same | PASS |
| 13 | scan_id of another device (DEV-RM301-01 prefix, no request to it) | BAD_REQUEST | same | PASS |
| 14 | admin dashboard: session | present 2, not_scanned 1, in progress | same | PASS |
| 15 | admin dashboard: device | online, low battery, alert shown | same | PASS |
| 16 | admin.listDevices | active, has_key, no hash | same | PASS |
| 17 | admin.listAttendance (class) | 2 rows, retry added none | total=2 (live + offline) | PASS |
| 18–20 | instructor01 reset → temp login → blocked until change → change | must_change, PASSWORD_CHANGE_REQUIRED, ok | same | PASS |
| 21 | instructor dashboard | present 2, not_scanned 1 | same | PASS |
| 22 | instructor live session | QA present, A present, B not_scanned | same | PASS |
| 23 | instructor recent activity | 2 items newest first | same | PASS |
| 24 | correction QA → late, reason "QA: arrived after the bell" | ok | ok | PASS |
| 25 | correction without reason | VALIDATION_ERROR | same | PASS |
| 26 | QA student first login + change password | ok | ok | PASS |
| 27 | student history | late + `correction {reason, by_role: Instructor}` | late, corrected=true, **no `correction` key** | **FAIL** (stale deploy) |
| 28 | student overview | late 1 | late 1 | PASS |
| 29 | UI instructor live session | "Not yet" + B shown, no page error | shown, **1 page error** (K2 view transition) | **FAIL** (minor) |
| 30 | UI student history | "Corrected by Instructor" + reason | **not shown** (no data from API) | **FAIL** (stale deploy) |
| 31 | UI student opens /admin/ | sent away | → student/index.html | PASS |
| 32 | class ended: instructor session | B absent, QA late, A present | same | PASS |
| 33 | admin dashboard after end | P1 L1 A1, not_scanned 0, ended | same | PASS |
| 34 | instructor dashboard after end | absent 1 | same | PASS |
| 35 | seeded B's own history | absent | absent | PASS |
| 36 | reports agree (API) | admin class group = instructor totals | P1 L1 A1, rate 0.667 both | PASS |
| 37 | CSV (UI export) admin vs instructor | P1 L1 A1 in both | same; instructor CSV 3 student rows | PASS |
| 38–39 | 5 wrong passwords, then right one | ACCOUNT_LOCKED, still locked | same | PASS |
| 40–41 | admin sees locked → unlockUser → login | locked → ok | same | PASS |
| 42–45 | admin.resetPassword: old pw fails, old session ended, temp pw blocked until change, new pw works | INVALID_CREDENTIALS, NOT_SIGNED_IN, PASSWORD_CHANGE_REQUIRED, ok | same | PASS |
| 46–55 | security (see section 5) | | all as expected | PASS |
| 56 | tools/live_device_test.mjs (section 4) | exit 0 | exit 0 | PASS |
| 57–59 | leak scan over all 84 replies | no hash, no chosen password, device key only in its issue reply | same | PASS |
| 60 | cleanup | everything inactive/retired, records kept | 2 schedules, class, device (retired), room, QA student (+ card revoked), section, subject | PASS |
| 61 | retired device key | INVALID_DEVICE_KEY | same | PASS |

Live request times (ms): tap 2321–3008, 3-scan batch 4218, admin.getDashboard 7158
(2330 in run 2), listAttendance 2105, instructor.getDashboard 2624, getSession 3370,
student.getHistory 2549, getClassReport 1925, getAttendanceReport 2192. Run 3 took 28 min
(mostly waiting for the class to end).

Left behind on the TEST Sheet: QA rows (inactive), and **random unknown passwords** for
`instructor01.test` and `9999000005`. Reset them in the editor:
`resetTestUserPassword('instructor01.test')`, `resetTestUserPassword('9999000005')`.
DEV-RM301-01 and RM301 schedules were not touched (step 13 only sent a scan_id string
with that prefix through the QA device, which the server refused).

---

## 3. Requirements (PROJECT_CONTEXT 6, 8, 9, 13, 14)

MET = proven by a test or a live step. Unit test files are in `backend/tests/`.

| Section | Requirement | Status | Proof |
|---|---|---|---|
| 6 | RFID-based attendance recording | MET | live #6, #9; submit-scans.test.js |
| 6 | Online database synchronization | MET | live #6–17 (rows land in the Sheet, read back in all views) |
| 6 | Accurate timestamping | MET (server) / N/A (NTP on ESP32) | server_time Manila +08:00: clock.test.js, server-gs.test.js |
| 6 | Web-based attendance dashboard | MET | live #14, #21, #33, #34 |
| 6 | Rechargeable battery operation | N/A (hardware) | |
| 6 | Offline buffering + automatic sync | MET (server) / N/A (firmware) | live #9–10, tool "20-scan offline batch"; submit-scans.test.js |
| 6 | LED and buzzer feedback | N/A (firmware) | server returns ACCEPTED / DUPLICATE / UNREGISTERED per scan (live #6–8) |
| 6 | Low-battery monitoring + dashboard alert | MET | live #11, #15; heartbeat-roster.test.js |
| 6 | Duplicate-scan prevention | MET | live #7, tool 40 sequential; sessions.test.js |
| 8 Admin | Manage student accounts | MET | live #1, #38–45, cleanup; users.test.js |
| 8 Admin | Register and assign RFID UIDs | MET | live #2; cards.test.js |
| 8 Admin | Manage instructors | MET | live #18 (reset); users.test.js |
| 8 Admin | Manage courses and sections | MET | live #4, cleanup; classes.test.js |
| 8 Admin | View all attendance records | MET | live #17; admin-attendance.test.js |
| 8 Admin | Generate reports | MET | live #36–37 |
| 8 Admin | Monitor device status | MET | live #15–16 |
| 8 Admin | Manage application settings | MET | settings.test.js; instructor refused live #48 |
| 8 Instructor | View assigned classes and sections | MET | live #21; portal.test.js |
| 8 Instructor | Monitor student attendance | MET | live #22, #29 (UI) |
| 8 Instructor | Class attendance history | MET | live #32; past-classes.test.js |
| 8 Instructor | Filter by date | MET | date-filters.test.js |
| 8 Instructor | Generate + export class reports | MET | live #36–37 (CSV from the UI) |
| 8 Student | Log in to own account | MET | live #26 |
| 8 Student | Attendance summary | MET | live #28 |
| 8 Student | Personal history, scan dates/times | MET | live #27 (status), #35 |
| 8 Student | Filter by date | MET | date-filters.test.js |
| 8 Student | Registered student information | MET | portal.test.js (`student.getProfile`, masked UID) |
| 8 | Students cannot edit / see others' records | MET | live #46, #50; portal.test.js |
| 9A | Totals (students, instructors), present today, statistics | MET | live #14, #33 (dashboard stats) |
| 9A | Student / instructor / course+section / attendance management, reports, device monitoring | MET | rows above |
| 9B | Assigned classes, students per section, present/absent counts | MET | live #21, #34 |
| 9B | Recent attendance activity | MET | live #23 |
| 9B | Attendance history, report generation | MET | live #32, #36–37 |
| 9C | Overview, percentage, history, date+time of each scan, profile | MET | live #28 (rate), #27, #35; portal.test.js |
| 9C | Correction reason visible to student | **PARTIAL** | code + tests OK (student-corrections.test.js); **live Web App is stale** (#27, #30) |
| 13 | Validate UID, reject unregistered, return result | MET | live #8, tool |
| 13 | Duplicate window (5 min), configurable | MET | settings `duplicate_window_minutes`; settings.test.js |
| 13 | NTP clock on ESP32 | N/A (firmware) | server accepts `time_quality`, keeps Manila time |
| 13 | Consistent timezone Asia/Manila | MET | all live timestamps `+08:00`; clock.test.js |
| 13 | Offline: save in flash, retry, remove after confirm | N/A (firmware) | server side: idempotent `scan_id` (live #10, tool) |
| 13 | No duplicate records during sync | MET | live #10, #17 (retry added no row) |
| 13 | Real data, device status + battery on dashboard | MET | live #14–15 |
| 13 | Pending offline vs synced records distinguished | MET | `pending_offline_scans` + `sync_mode` column (live #17 shows live/offline); admin-attendance.test.js |
| 14 | Role-based access control | MET | live #46–49 |
| 14 | Secure authentication | MET | live #38–45, #51–54; auth.test.js |
| 14 | No plaintext passwords | MET | passwords.test.js; live #57 |
| 14 | Students only their own records | MET | live #50 |
| 14 | Instructors only their assigned classes | MET | live #49 |
| 14 | Admin functions protected | MET | live #46, #48 |
| 14 | No secret API credentials in frontend JS | MET | section 5 |
| 14 | Validate ESP32 requests / no unauthorized submissions | MET | live #12, #13, #61 |
| 14 | Validate + sanitize inputs | MET | live #25; VALIDATION_ERROR tests in every handler suite; escapeHtml (section 5) |
| 14 | Sheet not public | PARTIAL | not checkable from the repo: confirm the Sheet is shared only with the owner (PRODUCTION_SETUP.md) |
| 14 | Use test data | MET | only QA / seeded fake data used |
| 14 | School approval before real data | N/A (organizational) | |
| 14 | UIDs not strong proof of identity | Noted | accepted design limit (cards can be cloned) |

---

## 4. Device API: `tools/live_device_test.mjs`

`prepareLiveTest` / `cleanupLiveTest` are editor-only (cannot be run from here) and
`prepareLiveTest` picks any room with an active device (could pick RM301). Same setup
done through the admin API instead: a second slot (00:36–01:08) for the QA class in
room QA-REL3 with device DEV-QA-REL3-01; LIVE_UIDS = QA, A, B; NOT_ENROLLED = C;
UNKNOWN = random FFEE…; afterwards the slot was set inactive (cleanup #60), the same
result `cleanupLiveTest` gives.

| test | expected | got | | ms (min / median / max) |
|---|---|---|---|---|
| heartbeat | ok + roster_version | ok | PASS | 3180 |
| getRoster (known_version 0) | changed, has all LIVE_UIDS | changed, 14 cards, 0 missing | PASS | 2715 |
| live scan | ACCEPTED | ACCEPTED | PASS | 3350 |
| same scan_id again | ALREADY_RECORDED | ALREADY_RECORDED | PASS | 2470 |
| same student, new scan_id | DUPLICATE | DUPLICATE | PASS | 2963 |
| not-enrolled UID | NOT_ENROLLED | NOT_ENROLLED | PASS | 2431 |
| unknown UID | UNREGISTERED | UNREGISTERED | PASS | 3398 |
| 20-scan offline batch | 2 ACCEPTED, 18 DUPLICATE | same | PASS | 3684 |
| wrong key | INVALID_DEVICE_KEY | same | PASS | 2310 |
| 40 sequential | 40 DUPLICATE | 40 DUPLICATE | PASS | 2313 / 3227 / 5777 |
| 10 parallel | 10 DUPLICATE (SERVER_BUSY allowed) | 8 DUPLICATE, 2 SERVER_BUSY | PASS | 2488 / 7349 / 12657 |

Single scan by result: ACCEPTED 3350; DUPLICATE n=49 2313 / 3343 / 12657;
NOT_ENROLLED 2431; UNREGISTERED 3398. **All tests PASSED.** 2 of 10 parallel got
SERVER_BUSY (the device retries them); the slowest reply was 12.7 s, under the 20 s
device timeout. These are TEST-Sheet sizes, not a full term.

---

## 5. Security pass

| Area | How checked | Result |
|---|---|---|
| Roles (API) | student → admin/instructor actions, instructor → admin action (live #46–48) | FORBIDDEN |
| Ownership (API) | instructor01 → other instructor's class (#49); student passes another `student_id` (#50) | refused; field ignored, own data only |
| Roles (UI) | student opens /admin/ (#31) | sent back to student portal (backend enforces anyway) |
| Sessions | no token, forged token, after logout, after password reset (#43, #51–53) | NOT_SIGNED_IN |
| Session expiry | server `expires_at` check (`auth/session.js`), frontend `getSession` drops expired | MET (auth.test.js); 8 h not waited live |
| Lockout | 5 wrong → locked, right password still locked, admin unlock (#38–41) | MET |
| Same error for unknown user / wrong password | #54 | MET |
| Secrets/hashes in replies | all 84 live replies scanned (#57–59) | none; device key only in its issue reply |
| Secrets in frontend | grep frontend for pepper, key, hash, secret; tracked secret files | none (only `API_URL`, which is public by design) |
| escapeHtml | every innerHTML template with API strings + shared helpers (toast, modal, confirm, state, select options) | all escaped; `escapeHtml` covers `& < > " '` |
| CSV | `csvText` prefixes `' ` to cells starting `= + - @`; tested in attendance-ui.test.js | MET |
| Device | wrong key, other device's scan_id, retired key (#12, #13, #61) | refused |

---

## 6. Fresh-eyes review (whole repo)

Reviewer verdict: **no Critical**, release "with fixes".

**Important — fixed here (with test):**
- **I-1 Blank header column shifts saved data.** If someone inserts a column with no
  header into a tab (e.g. Rooms, Users), every save wrote the following cells one
  column to the LEFT and still answered `ok:true` (Users → password_hash in the wrong
  column → user locked out). Root cause: `setTab_` (Server.gs) read by real column
  but kept headers without the blank ones. Fix: keep header positions. Test:
  `server-gs.test.js` "a column with a blank header … does not shift saved cells"
  (red before the fix, green after). Limit: a column with no header is written
  empty in rows the server saves — give it a header if it must keep data.
  Commit `793686c`. **Needs a redeploy of Server.gs to reach the live site.**

**Important — not code, release condition:**
- **I-2 Speed at term scale.** Login and device taps share one script lock;
  `device.submitScans` reads all of ScanLog + Attendance per tap (~10k rows read at
  5k rows each). Live today: 2.3–4.3 s per tap, 12.7 s worst under 10 parallel,
  2/10 SERVER_BUSY. Fine at TEST size; must be re-measured on a term-sized Sheet
  (FINAL_BACKEND_REVIEW P9) before real students.

**Minor (not fixed, no new features):** re-enrolled student keeps old `enrolled_at`;
admin dashboard rate counts not_scanned mid-class (portals don't); instructor
dashboard hides sessions of removed schedules; "View - Attendance" labels admin manual
rows "Instructor correction"; "Sign in as someone else" doesn't call `auth.logout`;
`changePassword` doesn't rate-limit the old password; no SRI on CDN tags;
`node_modules/` (Playwright) is tracked in git; `csvText` doesn't guard a leading
tab/CR (unreachable: `cleanText` strips them); `enrollStudents` accepts an inactive
class; **K2** view-transition page error on Chromium portal→portal navigation (live #29,
reproduced locally; already fixed on `redesign`).

---

## Verdict: NO-GO (today)

Why:
1. **The live Web App runs an old bundle.** `student.getHistory` has no `correction`
   field (live #27, #30), so students cannot see correction reasons. The code and tests
   are right; the deployment is behind (same finding as the student audit of 2026-11-21).
2. **Fix I-1 is only in the repo**, not on the live site yet.

To reach GO (no code work left):
1. `node tools/build_apps_script.mjs`, paste `Server.gs` + `Bundle.gs` into the TEST
   project → Save → Deploy → Manage deployments → Edit → **New version** → Deploy.
2. Re-run live steps #26–30 (student sees "Corrected by Instructor: reason").
3. Reset `instructor01.test` and `9999000005` with `resetTestUserPassword`.
4. Before real students: production deploy per PRODUCTION_SETUP.md, confirm the Sheet
   is private, and run the term-size speed check (I-2).

Everything else — all roles, device API, offline/idempotent sync, absent rule,
reports and CSV agreement, lockout/reset, roles and ownership — passed live.
