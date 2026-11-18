# Audit Report — IoT-Based RFID Attendance Monitoring System

| | |
|---|---|
| Audit date | 2026-11-18 |
| Commit audited | `bfdbb89` (branch `main`, working tree clean) |
| Type | Read-only audit. No source file was changed. |
| Login model used as the reference | **New username/password model** (admin-created accounts, default passwords, forced first-login change). Google Sign-In is treated as **OUTDATED** everywhere. |

Legend: **UNVERIFIED** = could not be confirmed from the repo or a safe local command (e.g., needs the live Google Sheet / Apps Script project).

---

## 1. Summary

1. The **web portals + admin CRUD + a real Apps Script backend** exist and share one handler codebase (`frontend/assets/js/demo/handlers/` → generated `backend/apps-script/Bundle.gs`, verified in sync). Admin, Instructor, and Student portals all call real backend actions.
2. **Not started:** the new login (no `auth.login`, no passwords at all), the **Device API** (`device.*`), the **session engine** (room+time → session, present/late), Devices/Settings admin pages, manual session start, and **firmware** (no `firmware/` folder in the repo).
3. Rough completion: **~40%** of the full system (web/admin side ~70%, device + session engine + new login ~0%).
4. **Biggest risk (CRITICAL):** `config.js` ships `MODE: 'live'`, the real Web App URL, and `TEST_LOGIN: true`. If the Apps Script property `ALLOW_TEST_LOGIN` is `true` (UNVERIFIED), **anyone** can call `auth.testSignIn {role:"admin"}` and become admin with no password.
5. Second risk: attendance can only enter the system through instructor manual corrections; real RFID taps have nowhere to go yet.

---

## 2. Folder map

```
RFID-Attendance-Monitoring-System/
├── README.md                      (outdated: says backend not in repo)
├── .gitignore                     (firmware secrets, *.local.js, .DS_Store, __pycache__)
├── backend/
│   ├── README.md                  Setup guide (Google Sign-In parts are OUTDATED)
│   └── apps-script/
│       ├── Server.gs              Router, auth/sessions, Sheet read/write, setupSheets/Views
│       ├── Bundle.gs              GENERATED from frontend handlers (2,320 lines)
│       ├── SeedData.gs            GENERATED fake data (3,114 lines)
│       └── appsscript.json        Manila TZ, V8, Sheets advanced service, ANYONE_ANONYMOUS
├── docs/
│   ├── RFID_Attendance_System_Architecture.md
│   ├── Device_API_Spec.md
│   └── RFID_Test_Data.xlsx        Fake test data workbook
├── frontend/
│   ├── index.html                 Login page
│   ├── README.md                  (outdated status table)
│   ├── admin/      index, students, instructors, admins, classes, academic (.html)
│   ├── instructor/ index, attendance, reports (.html)
│   ├── student/    index, history, profile (.html)
│   └── assets/
│       ├── css/    app.css, auth.css, bubbles.css
│       └── js/     config, api, auth, session, ui, auth-forms, bubbles
│           ├── components/  resource-manager.js, attendance-ui.js
│           ├── pages/       one script per page (+ instructor-history.js modal helper)
│           └── demo/        demo-api, demo-store, demo-utils, demo-data (GENERATED), actions.js
│               └── handlers/ dashboard, students, classes, academic, instructors, admins, portal
└── tools/
    ├── build_apps_script.mjs      Builds Bundle.gs + SeedData.gs from the frontend
    └── xlsx_to_demo_data.py       Builds demo-data.js from the xlsx
```

| Top-level folder | What it contains |
|---|---|
| `backend/` | Google Apps Script server (Server.gs hand-written; Bundle.gs/SeedData.gs generated) |
| `docs/` | Architecture, Device API spec, fake test-data workbook. **`PROJECT_CONTEXT.md` is MISSING** (referenced in arch doc §5.2 and §12.3) |
| `frontend/` | Static HTML/CSS/JS + Bootstrap 5.3.3 site for GitHub Pages; also hosts the shared business logic (`demo/handlers`) |
| `tools/` | Build/generation scripts |
| `firmware/` | **Does not exist.** Only referenced by `.gitignore` |

### 2.1 Requirement documents

| Document | Found? |
|---|---|
| `PROJECT_CONTEXT.md` (primary) | **MISSING** |
| `docs/RFID_Attendance_System_Architecture.md` | Found (v0.2, describes Google Sign-In — OUTDATED for login) |
| `docs/Device_API_Spec.md` | Found (v0.1 draft) |
| READMEs | `README.md`, `backend/README.md`, `frontend/README.md` — all partly outdated |

### 2.2 Pages (13)

| Page | Script | Backend actions used |
|---|---|---|
| `frontend/index.html` (login) | `pages/login.js`, `auth-forms.js`, `bubbles.js` | `auth.testSignIn` / `auth.demoSignIn`, `auth.google` |
| `admin/index.html` | `admin-dashboard.js` | `admin.getDashboard` |
| `admin/students.html` | `admin-students.js` | `admin.getStudentOptions, listStudents, getStudent, createStudent, updateStudent, setStudentStatus, assignCard, revokeCard, listUnregisteredUids` |
| `admin/instructors.html` | `admin-instructors.js` | `admin.listInstructors, createInstructor, updateInstructor, setInstructorStatus` |
| `admin/admins.html` | `admin-admins.js` | `admin.listAdmins, createAdmin, updateAdmin, setAdminStatus` |
| `admin/classes.html` | `admin-classes.js` | `admin.getClassOptions, listClasses, getClass, createClass, updateClass, setClassStatus, addSchedule, removeSchedule, enrollStudents, dropEnrollment` |
| `admin/academic.html` | `admin-academic.js` | terms / programs / sections / subjects / rooms list+create+update+status, `setActiveTerm` |
| `instructor/index.html` | `instructor-dashboard.js` | `instructor.getDashboard`, `getClassRoster`, `getStudentHistory` |
| `instructor/attendance.html` | `instructor-attendance.js` | `instructor.listSessions, getSession, correctAttendance` |
| `instructor/reports.html` | `instructor-reports.js` | `instructor.getClassReport` (+ CSV export in browser) |
| `student/index.html` | `student-dashboard.js` | `student.getOverview` |
| `student/history.html` | `student-history.js` | `student.getHistory` |
| `student/profile.html` | `student-profile.js` | `student.getProfile` |

### 2.3 Apps Script functions (`Server.gs`)

`doPost`, `doGet`, `reply_`, `success_`, `failure_`, `handleRequest_`, `apiError_`, `props_`, `googleSignIn_`, `testSignIn_`, `startSession_`, `logout_`, `authorize_`, `displayName_`, `hash_`, `spreadsheet_`, `loadDb_`, `readAllTabs_`, `snapshot_`, `saveDb_`, `defaultHeaders_`, `setupSheets`, `setupViews`, `buildView_`, `checkSetup`, `isViewTab_`.
`Bundle.gs` exposes `RFID` = `CONFIG` + demo-utils helpers + `ACTIONS`/`READ`/`WRITE`.

### 2.4 API actions that exist on the backend

- Public (`Server.gs:63-67`): `auth.google`, `auth.testSignIn`, `auth.logout`
- Portal (`frontend/assets/js/demo/actions.js:19-78`): 39 `admin.*`, 7 `instructor.*`, 3 `student.*` (full list in §2.2)
- Demo-only (`demo-api.js:8-13`): `auth.demoSignIn`, `demo.reset`
- **Missing:** `auth.login`, `auth.changePassword`, `auth.me`, `users.resetPassword`, all `device.*`, devices/settings CRUD, session start/extend/close/cancel, audit/scan log viewers.

### 2.5 Google Sheets tabs and columns referenced (from `SeedData.gs`, verified with node)

| Tab | Columns |
|---|---|
| Terms | term_id, term_name, start_date, end_date, is_active |
| Programs | program_id, program_code, program_name, status |
| Sections | section_id, program_id, year_level, section_name, status |
| Subjects | subject_id, subject_code, subject_title, units, status |
| Rooms | room_id, room_code, room_name, building, status |
| Instructors | instructor_id, first_name, last_name, email, department, account_status |
| Students | student_id, student_number, first_name, last_name, program_id, year_level, section_id, email, account_status |
| **Users** | user_id, email, **google_sub**, role, linked_id, account_status, created_by, last_login_at, created_at, updated_at (+ `display_name` added at runtime for admins, `admins.js:68`) |
| RfidCards | card_id, rfid_uid, student_id, status, assigned_at, revoked_at, notes |
| Devices | device_id, room_id, device_name, device_key_hash, status, firmware_version, battery_voltage, wifi_rssi, queue_count, time_synced, last_seen_at, last_heartbeat_at, notes |
| Classes | class_id, term_id, subject_id, section_id, instructor_id, class_label, late_grace_minutes, status |
| Schedules | schedule_id, class_id, room_id, day_of_week, start_time, end_time, status |
| Enrollments | enrollment_id, class_id, student_id, status, enrolled_at |
| ClassSessions | session_id, class_id, room_id, schedule_id, session_date, scheduled_start, scheduled_end, actual_start, actual_end, source, status, opened_by, closed_by, override_reason, created_at |
| Attendance | attendance_id, session_id, student_id, card_id, rfid_uid, device_id, scan_id, scanned_at, received_at, status, source, sync_mode, time_quality, created_by |
| ScanLog | log_id, scan_id, device_id, rfid_uid, scanned_at, received_at, result, session_id, student_id, attendance_id, sync_mode |
| AuditLog | audit_id, timestamp, user_id, role, action, entity_type, entity_id, before_json, after_json, reason |
| AuthSessions | token_hash, user_id, created_at, expires_at, revoked (`Server.gs:22`) |
| Settings | key, value, description, source — keys: duplicate_window_minutes, low_battery_voltage, late_grace_minutes, early_window_minutes, accept_after_end_minutes, device_offline_after_minutes, heartbeat_interval_seconds, session_token_hours, roster_version, **allowed_email_rule** |
| View - Scans, View - Attendance | Formula-only read views built by `setupViews()` (`Server.gs:365-432`) |

### 2.6 Checks I ran

| Command | Result |
|---|---|
| Rebuilt `Bundle.gs`/`SeedData.gs` in a **scratch copy** (`git archive` → `node tools/build_apps_script.mjs`) and diffed with `diff -w --strip-trailing-cr` | **In sync** (only whitespace/date header differ) |
| `node --check` on every `.js`/`.mjs` in `frontend/` and `tools/`, and on `Server.gs` | **All pass** |
| Tests / linters | **None exist** (no `package.json`, no test files, no ESLint config) |
| Live Web App / Google Sheet | **Not contacted** (read-only audit). Anything about the deployed state is UNVERIFIED |

---

## 3. Feature status

| Feature | Status | Evidence | What's missing |
|---|---|---|---|
| **LOGIN (new model)** | | | |
| Login page (username + password) | **PARTIAL (UI only, wrong field)** | `index.html:35-48` has an email field labelled "PSU email" + password; `auth-forms.js:12-21` returns a fake "not used" message after 700 ms | Change field to username/student number; wire to `auth.login`; remove demo/test buttons for prod |
| `auth.login` | **NOT STARTED** | Not in `Server.gs:63-67` nor `actions.js` | Whole action |
| Password hashing (salted) | **NOT STARTED** | No password columns in Users (§2.5); `hash_` is unsalted SHA-256 used only for session tokens (`Server.gs:217-220`) | Salt + iterated hash helper, Users columns |
| Session tokens | **DONE** | Random token, SHA-256 hash stored in AuthSessions, expiry from `session_token_hours`, checked every request (`Server.gs:159-206`) | Reuse as-is for the new login |
| Forced first-login password change | **NOT STARTED** | No `must_change_password` anywhere | Column + server check + UI redirect |
| Change password in Settings | **NOT STARTED** | No Settings/Account page in any nav (`ui.js:5-39`) | Page + `auth.changePassword` |
| Admin create instructor (username + full name) | **PARTIAL** | `instructors.js:63-82` creates Instructor + Users row, but requires **email + department** and stores no username/password | Username field, default password from Script Properties, `must_change_password=TRUE` |
| Admin create student (student no. = username) | **PARTIAL** | `students.js:174-205` creates Student + Users row; requires email (`students.js:164`); no username/password | Same as above, username = student_number |
| Admin reset password | **NOT STARTED** | No `users.resetPassword` | Action + button |
| Login lockout | **NOT STARTED** | No attempt counter anywhere | `failed_attempts`, `locked_until` |
| Logout | **DONE** | `auth.logout` revokes token (`Server.gs:187-194`); UI clears session (`auth.js:46-54`) | — |
| `auth.me` | **NOT STARTED** | Not in router | Action |
| **Backend role enforcement** | **DONE (for existing actions)** | `authorize_` checks token, active user, exact role (`Server.gs:196-206`); student/instructor handlers use `linked_id` from session, never from request (`portal.js:16-22`, `ownClass` `portal.js:131-137`, `studentHistory` `portal.js:579-585`) | Keep this pattern for new actions |
| **Admin CRUD** | | | |
| Students | **DONE** | `students.js` + `admin/students.html` | Email requirement must change for new login |
| RFID cards (assign/replace/revoke, unknown-UID picker) | **DONE** | `students.js:270-359` | — |
| Instructors | **DONE** (Google-oriented) | `instructors.js` | Login fields |
| Admins | **DONE** (Google-oriented) | `admins.js` | Login fields |
| Subjects, Sections, Programs, Terms, Rooms | **DONE** | `academic.js` + `admin/academic.html` | — |
| Classes | **DONE** | `classes.js:148-225` | — |
| Schedules + overlap check | **DONE** | Room / instructor / section clash `classes.js:229-285` | Reactivating a class does not re-check clashes (ISS-14) |
| Enrollments | **DONE** | `classes.js:298-355` | — |
| Devices | **NOT STARTED** | No `admin.*Device*` action; `admin-academic.js:128` refers to a "Devices page" that does not exist | Page, actions, key generation |
| Settings | **NOT STARTED** | Read-only via `setting()` (`demo-utils.js:18-21`); "Settings" mentioned in UI text (`admin-classes.js:225,282`) but no page | Page + actions |
| **Device API** | | | |
| `device.submitScans` | **NOT STARTED** | Not in router | Everything |
| `device.heartbeat` | **NOT STARTED** | — | Everything |
| `device.getRoster` | **NOT STARTED** | `roster_version` is bumped on card changes (`students.js:37-40`) but nothing serves it | Everything |
| Hashed device keys | **NOT STARTED** | Column `device_key_hash` exists but empty in seed data | Key generate/rotate + verify |
| `scan_id` idempotency | **NOT STARTED** | Column exists in Attendance/ScanLog only | Logic |
| LockService on writes | **DONE** | `Server.gs:76-81` (all WRITE actions, 20 s wait) | Device writes must also be WRITE |
| Session resolution (room + schedule + time) | **NOT STARTED** | Only dashboards *display* expected sessions from Schedules (`dashboard.js:47-62`); nothing creates ClassSessions | Engine per arch §4.2 |
| Manual start / override | **NOT STARTED** | No `sessions.*` action | — |
| Present vs late (late_grace_minutes) | **NOT STARTED** (data only) | `late_grace_minutes` stored (`classes.js:138-146`) but never used to classify a scan | Engine |
| Absent computed | **DONE** | `statusOf` / `sessionCounts` compute enrolled − present/late (`portal.js:85-113`, `dashboard.js:42`) | — |
| ScanLog | **PARTIAL** | Read only: dashboard recent scans + unregistered UIDs (`dashboard.js:98-114`, `students.js:342-359`) | Writing (needs Device API); viewer page |
| AuditLog | **PARTIAL** | Written on every admin/instructor write (`writeAudit` `demo-utils.js:74-90`) | No login/logout audit; no viewer page |
| Instructor portal | **DONE (on top of existing data)** | Dashboard, attendance list, corrections, roster, history, reports | Live session start/extend/cancel |
| Student portal | **DONE** | Overview, history, profile | Change-password link |
| Device status + low-battery alerts | **PARTIAL** | Dashboard shows battery/online/queue from Devices tab (`dashboard.js:80-136`) | Data only arrives once heartbeat exists |
| Reports / CSV export | **PARTIAL** | Instructor class report + CSV (`instructor-reports.js:254`, `attendance-ui.js:103-118`) | Admin-wide reports, server-side export |
| **Firmware** (NTP, LittleFS queue, 302→GET, LCD/LED/buzzer, cooldown, battery) | **NOT STARTED / NOT IN REPO** | No `firmware/` folder (`find` output §2) | Entire firmware — UNVERIFIED whether it exists elsewhere (Jezreel's machine?) |

---

## 4. Google Sign-In removal list

Every place that must be removed or replaced for the new login model.

### 4.1 Code

| File:line | What it is | Replace with |
|---|---|---|
| `backend/apps-script/Server.gs:16` | Doc comment: `GOOGLE_CLIENT_ID` script property | Document `DEFAULT_INSTRUCTOR_PASSWORD`, `DEFAULT_STUDENT_PASSWORD` (and maybe `PASSWORD_PEPPER`) |
| `backend/apps-script/Server.gs:17-18` | Doc comment: `ALLOW_TEST_LOGIN` | Remove together with test login |
| `backend/apps-script/Server.gs:64` | Route `'auth.google'` | `'auth.login'`, plus `auth.changePassword`, `auth.me`, admin `users.resetPassword` |
| `backend/apps-script/Server.gs:65` | Route `'auth.testSignIn'` | Remove (a bootstrap admin replaces it) |
| `backend/apps-script/Server.gs:115-145` | `googleSignIn_`: tokeninfo call (`:121-124`), `id_token` (`:118`), `aud/iss` check (`:127-130`), `email_verified` (`:131`), `google_sub` binding (`:139-143`) | `passwordLogin_`: look up by username, check lockout, verify salted hash, increment/reset `failed_attempts`, return `must_change_password` |
| `backend/apps-script/Server.gs:149-157` | `testSignIn_` | Remove |
| `backend/apps-script/Server.gs:438-439` | `checkSetup` logs `GOOGLE_CLIENT_ID` / `ALLOW_TEST_LOGIN` | Log whether default-password properties are set |
| `backend/apps-script/appsscript.json:16` | `script.external_request` scope — needed only for tokeninfo `UrlFetchApp` | Remove if nothing else uses `UrlFetchApp` (fewer permissions) |
| `frontend/assets/js/config.js:12-13` | `GOOGLE_CLIENT_ID` | Remove |
| `frontend/assets/js/config.js:15-17` | `TEST_LOGIN: true` | Remove |
| `frontend/assets/js/auth.js:19-23` | `signInDemo` → `auth.testSignIn` in live mode | Live: `signIn(username, password)` → `auth.login`. Keep demo path only for `MODE:'demo'` |
| `frontend/assets/js/auth.js:25-28` | `signInWithGoogle(idToken)` / `auth.google` / `id_token` | Remove |
| `frontend/assets/js/pages/login.js:3` | imports `signInWithGoogle` | Import the new `signIn` |
| `frontend/assets/js/pages/login.js:12` | `GOOGLE_SCRIPT = 'https://accounts.google.com/gsi/client'` | Remove |
| `frontend/assets/js/pages/login.js:27` | Banner "Google Sign-In is not connected yet" | "Demo mode: fake data" |
| `frontend/assets/js/pages/login.js:46-47, 55, 60` | `googleButton` container, "Add GOOGLE_CLIENT_ID" message, button load | Remove |
| `frontend/assets/js/pages/login.js:63-88` | `loadGoogleButton()` (GIS `initialize`, `renderButton`) | Remove |
| `frontend/assets/js/pages/login.js:49-53` | "Test as Admin/Instructor/Student" buttons in live mode | Remove for live |
| `frontend/assets/js/auth-forms.js:12-21` | Fake `submitToServer` ("Password sign-in is not used") | Call `auth.login`; on `must_change_password` show change-password view |
| `frontend/index.html:36-39` | Email input "PSU email", `type="email"` | Username / student number input, `type="text"` |
| `frontend/index.html:52-55` | "Remember me" checkbox — not read anywhere | Remove or implement |
| `frontend/index.html:56, 76-101` | "Forgot password?" → "send you a link" email reset (fake) | "Forgot password? Ask your administrator to reset it." |
| `frontend/index.html:66-69` | "or try the demo" divider + comment "Google sign-in later" | Show only in demo mode |
| `frontend/assets/js/pages/admin-admins.js:14, 38, 43, 45-46, 50` | "Google account email", "Google: Linked / Not signed in yet" column, unlink notices | Username field, "Must change password" / "Locked" status, **Reset password** action |
| `frontend/assets/js/pages/admin-instructors.js:14, 39, 44, 59-60, 64` | Same Google wording/column | Username + full name form; Reset password action |
| `frontend/assets/js/pages/admin-students.js:285, 287, 333, 363, 368` | "Google email", "Google link", email help text, unlink notices | Show username (= student number), password status, Reset password |
| `frontend/assets/js/demo/handlers/students.js:112, 193, 223-228, 232` | `google_linked`, `google_sub`, `google_unlinked` | `username`, `must_change_password`, `locked` |
| `frontend/assets/js/demo/handlers/instructors.js:30, 71, 90-98` | same | same |
| `frontend/assets/js/demo/handlers/admins.js:46, 60, 79-88` | same | same |
| `frontend/assets/js/demo/handlers/portal.js:603` | `google_linked` in student profile | Remove / replace with `password_changed_at` |
| `frontend/assets/js/demo/demo-api.js:52-77` | Demo sign-in by role (no password) | OK for demo mode; add a demo `auth.login` so demo mirrors live |

### 4.2 Data

| File:line | What it is | Replace with |
|---|---|---|
| `frontend/assets/js/demo/demo-data.js:282+` and `backend/apps-script/SeedData.gs:284+` (Users) | `google_sub` column; `email` as identity (`@example.com`) | Users columns: `username`, `password_hash`, `password_salt`, `must_change_password`, `failed_attempts`, `locked_until`, `password_changed_at` (drop `google_sub`) |
| `demo-data.js:3106` / `SeedData.gs:3108` | Setting `allowed_email_rule = gmail_or_hd` | Remove; add `max_login_attempts`, `lockout_minutes` |
| `docs/RFID_Test_Data.xlsx` (Users, Settings sheets) | Source of the above — regenerated by `tools/xlsx_to_demo_data.py` | Update the workbook, then re-run both generators. **Never put real or default passwords in the xlsx** — only hashes, or leave blank and let `setupSheets()` set them |

### 4.3 Docs

| File:line | What it is |
|---|---|
| `backend/README.md:71-79` | "Turn on test sign-in" (`ALLOW_TEST_LOGIN`) |
| `backend/README.md:96-101, 109` | config with `GOOGLE_CLIENT_ID`, `TEST_LOGIN`, "Test as…" buttons |
| `backend/README.md:116-135` | Whole "Real sign-in: Google Sign-In" section |
| `backend/README.md:166` | "Google handles passwords" |
| `frontend/README.md:10, 46, 72, 101, 103, 122` | Google Sign-In, `GOOGLE_CLIENT_ID`, `auth.google`, `google_linked`, `google_unlinked`, "email change unlinks Google" |
| `docs/RFID_Attendance_System_Architecture.md:355-367` | Users table "no password columns", `google_sub` |
| same `:551` | `allowed_email_rule` |
| same `:752-753` | `auth.google`, `users.resetGoogleBinding` |
| same `:762-798` | §6.11 Google Sign-In sequence |
| same `:842-843, 852` | Roadmap Phase 0/1 + MVP cut line require Google Sign-In / OAuth Client ID |
| same `:863, 888-889` | Decision #1 "FINALIZED (F1): Google Sign-In", #26, #27 |
| same `:922-956` | §12 Google Sign-In setup & limitations |
| same `:966-971` | Phase 0 checklist items 4-7 (Gmail test users, Cloud project, consent screen, OAuth Client ID) |
| `docs/Device_API_Spec.md:89` | "Students' and instructors' Google logins are never used on the device" (harmless, just reword) |

---

## 5. Issues (sorted by severity)

| ID | Severity | Category | File:line | Problem | Why it matters | Suggested fix |
|---|---|---|---|---|---|---|
| ISS-01 | **CRITICAL** | Security | `frontend/assets/js/config.js:7,10,17`; `Server.gs:65,149-157`; `appsscript.json:12` | Live mode + real Web App URL + `TEST_LOGIN: true` are committed. Server `auth.testSignIn` signs anyone in as the first active admin/instructor/student when `ALLOW_TEST_LOGIN=true`. Web App access is `ANYONE_ANONYMOUS`. Whether the property is on now is **UNVERIFIED**, but `TEST_LOGIN:true` in the frontend suggests it is. | Anyone who opens the site (or reads the repo) can become **admin** with one POST — no password — and read/edit all student data. | **Today:** delete `ALLOW_TEST_LOGIN` from Script Properties. Then remove `auth.testSignIn` entirely when `auth.login` lands. |
| ISS-02 | **CRITICAL** | Core functionality | `Server.gs:63-67` | No real login exists (`auth.login`, password hashing, change password, reset, lockout, `auth.me` all missing). Only Google (unconfigured) or test login. | Every portal depends on it; no safe way for real users to sign in. | Implement the new login model (Fix-First #1). |
| ISS-03 | **CRITICAL** | Core functionality | `actions.js:19-78`, `Server.gs:63-67` | No Device API and no session engine. Nothing ever creates `ClassSessions` or device `Attendance`/`ScanLog` rows. | The main purpose (RFID tap → attendance) does not work end-to-end. Firmware has nothing to talk to. | Build `device.submitScans/heartbeat/getRoster` + resolution per arch §4.2 (Fix-First #3). |
| ISS-04 | **HIGH** | Security | `Server.gs:115-145` | Google sign-in code is still routed and reachable. Not exploitable while `GOOGLE_CLIENT_ID` is empty (`:117`), but it is dead attack surface + extra OAuth scope. | Confusing, and could be switched on by mistake. | Remove with ISS-02. |
| ISS-05 | **HIGH** | Security | (missing) | No login lockout / rate limit planned code exists; Apps Script has no built-in throttling. | Once passwords exist, default passwords (`DEFAULT_STUDENT_PASSWORD`) can be brute-forced across all student numbers. | `failed_attempts` + `locked_until` per user; force change on first login so defaults stop working. |
| ISS-06 | **HIGH** | Integration / docs | Repo root | `PROJECT_CONTEXT.md` (primary requirements) and `firmware/` are missing from the repo. | Requirements and hardware progress can't be verified; firmware not version-controlled. | Add both (firmware with `secrets.h` ignored — rule already in `.gitignore:1-2`). |
| ISS-07 | **MEDIUM** | Correctness / data integrity | `portal.js:353-357` | Instructor correction **deletes** the Attendance row when set to Absent and **edits device rows in place** (`record.status = status`). | Violates arch §7.2 rule 4 ("device-created rows are never edited in place"); deleting breaks `scan_id` idempotency later (a retried scan could re-create the row). `backend/README.md:157-159` already notes it. | Add `voided`/`override_status` columns; never delete; keep original device status. |
| ISS-08 | **MEDIUM** | Performance | `Server.gs:231-255, 260-267` | Every request (reads too) loads **every tab**, including ever-growing ScanLog/Attendance/AuditLog, and JSON-snapshots all of them on writes (`:269-275`). | Device scans need fast replies (arch §10 "Apps Script response delay"); this gets slower every day. | Load only the tabs an action needs; cache rarely-changing tabs with `CacheService`; archive per term. |
| ISS-09 | **MEDIUM** | Integration | `Server.gs:80` vs `Device_API_Spec.md:265` | Server returns error code `BUSY`; spec says `SERVER_BUSY`. | Firmware written to spec won't recognise the busy case. | Rename to `SERVER_BUSY` (or update the spec). |
| ISS-10 | **MEDIUM** | Correctness | `students.js:207-233` | Changing a student's section does not update enrollments in old/new section classes. | Student stays on the old instructors' rosters and is missing from the new ones. | On section change, offer to drop old-section classes and `enrollInSectionClasses` for the new one. |
| ISS-11 | **MEDIUM** | Security | `index.html:8-9`, all portal HTML (e.g. `admin/index.html:7-8,14`) | Bootstrap CSS/JS from jsDelivr without SRI hashes (also noted in `frontend/README.md:132`). | A compromised CDN file could steal session tokens. | Add `integrity` + `crossorigin` attributes. |
| ISS-12 | **MEDIUM** | Docs / consistency | `frontend/assets/js/config.js:7` vs `frontend/README.md:32` | README says `demo` is the current mode; code is `live`. Opening the site uses the real backend. | Teammates may think they are on fake data while editing the real Sheet. | Decide the default; document it. |
| ISS-13 | **MEDIUM** | UI/UX | `ui.js:5-39`, `admin-academic.js:128`, `admin-classes.js:225,282` | UI text points to a "Devices page" and "Settings" that don't exist; no Settings/Account page in any portal. | Dead references; nowhere to change password. | Add Settings (password) for all roles; Devices + System Settings for admin. |
| ISS-14 | **LOW** | Correctness | `classes.js:211-225` | Re-activating a class does not re-run `scheduleClash`, so its schedules can overlap another class that took the room meanwhile. | Two classes could own the same room/time → wrong session resolution later. | Run `scheduleClash` on activate. |
| ISS-15 | **LOW** | Correctness | `dashboard.js:23-25` vs `portal.js:103` | Admin dashboard counts **all** attendance rows of a session; instructor view counts only enrolled students. | Numbers differ between portals for the same session (e.g., after a drop). | Filter by roster in the admin dashboard too. |
| ISS-16 | **LOW** | Consistency | `Server.gs:52,58,172` vs `demo-utils.js:29` | `server_time` and `AuthSessions.expires_at` are UTC `...Z`; everything else is `+08:00`. Spec example uses `+08:00` (`Device_API_Spec.md:166`). | Mixed formats in the same Sheet; confusing for humans and firmware parsing. | Use `RFID.manilaNow().iso` style everywhere. |
| ISS-17 | **LOW** | Consistency | `students.js:166`, `instructors.js:56` vs `admins.js:31` | Email-uniqueness check is case-sensitive on stored rows in students/instructors but lower-cased in admins. | Hand-edited mixed-case emails in the Sheet bypass the check. (Becomes moot if email stops being the login key.) | Same normalisation everywhere; apply it to `username` too. |
| ISS-18 | **LOW** | Security | `attendance-ui.js:104-107` | CSV export doesn't neutralise cells starting with `= + - @`. Names are restricted by regex, but reasons/labels aren't everywhere. | CSV/formula injection when opened in Excel. | Prefix such cells with `'`. |
| ISS-19 | **LOW** | UI/UX | `index.html:52-55` | "Remember me" checkbox is never read. | Dead control. | Remove or implement. |
| ISS-20 | **LOW** | Code quality | `build_apps_script.mjs:19,85` | `config.js` (with API URL, `TEST_LOGIN`) is bundled into the server; server only needs `TIMEZONE`. | Frontend config changes silently become server code. | Move `TIMEZONE` to a tiny shared module. |
| ISS-21 | **LOW** | Code quality | Repo | No tests, no linter. | Regressions in the shared handlers hit both demo and live. | Add a few Node unit tests for handlers (they're pure functions on a `db` object — easy to test). |
| ISS-22 | **LOW** | Docs | `README.md:11`, `frontend/README.md:15`, arch doc `:911` | Status text says backend/portals don't exist. | Misleads the team/panel. | Update (see §6). |

**Checked and OK (no issue):**
- `fetch()` uses `Content-Type: text/plain;charset=utf-8` (`api.js:45`) — correct for Apps Script (no CORS preflight).
- Every frontend `callApi` action exists in the backend router (cross-checked §2.2 vs `actions.js`).
- Students cannot read another student's data: student actions ignore any `student_id` and use `linked_id` from the session (`portal.js:544-606`); `studentHistory` rejects non-enrolled classes (`portal.js:584`).
- Instructors are limited to their own classes (`ownClass`, `portal.js:131-137`) and enrolled students (`portal.js:466-468`).
- Writes are under `LockService` and fail atomically (`Server.gs:76-100`).
- Dates/times kept as plain text (`setNumberFormat('@')`, `Server.gs:295,310,317,344`); Manila time via `Utilities.formatDate` (`demo-utils.js:25-29`).
- HTML output is consistently passed through `escapeHtml` (spot-checked all pages).
- No Wi-Fi passwords or device keys in the repo (`device_key_hash` empty in seed data; no firmware).

---

## 6. Mismatches between code and docs

| Doc says | Code does | Evidence |
|---|---|---|
| Login = Google Sign-In (arch §6.11, F1) | Test login only; new agreed model is username/password | `Server.gs:63-67` — **docs outdated** |
| Users table has no password columns (arch `:367`) | — needs password columns under new model | §4.2 |
| `README.md:11`: backend and firmware not in repo | Backend **is** in repo; firmware isn't | `backend/apps-script/` |
| `frontend/README.md:15`: Instructor/Student portals "Not started"; `:32` demo is current | Both portals exist; `MODE:'live'` | `frontend/instructor/`, `config.js:7` |
| Arch §11 status: "No backend exists yet" | Backend exists | `Server.gs` |
| `backend/README.md:163` calls it `device.scan` | Spec calls it `device.submitScans` | `Device_API_Spec.md:132` |
| Spec busy code `SERVER_BUSY` | `BUSY` | `Server.gs:80` (ISS-09) |
| Spec `server_time` example `+08:00` | UTC `Z` | `Server.gs:52` (ISS-16) |
| Arch §5.1: IDs like `STU-000123` (6 digits) | 4 digits (`STU-0001`), Attendance 5 | `demo-utils.js:92`, `portal.js:362` |
| Arch §5.4 Students status includes `graduated` | Only `active`/`inactive` | `students.js:237` |
| Arch §5.4 Schedules: instructor overlap = **warning** | Instructor (and section) overlap = **blocking error** | `classes.js:245-246` |
| Arch §7.2.4: device rows never edited in place | Edited / deleted on correction | `portal.js:353-357` (ISS-07) |
| Arch §7.1: Admin can correct attendance | No admin correction action; instructor only | `actions.js:71` |
| Spec §3 Header `application/json` for the device | Fine for ESP32 (no CORS). Browser correctly uses `text/plain` | `api.js:45` — not a bug, just note it |

---

## 7. FIX-FIRST PLAN

| # | What | Files | Effort |
|---|---|---|---|
| 0 | **Today, 5 minutes:** delete `ALLOW_TEST_LOGIN` from Apps Script → Script Properties and redeploy. Set `TEST_LOGIN:false` in `config.js`. (Closes ISS-01 until #1 lands.) | Apps Script console, `config.js` | S |
| 1 | **New login backend.** Users columns (`username`, `password_hash`, `password_salt`, `must_change_password`, `failed_attempts`, `locked_until`, `password_changed_at`); salted + iterated SHA-256 (e.g. 10k rounds of `Utilities.computeDigest`) helper; `auth.login`, `auth.me`, `auth.changePassword`, admin `users.resetPassword`; lockout; defaults read from Script Properties; bootstrap admin created by a one-time editor function. Remove `auth.google`, `auth.testSignIn`, `google_sub`. | `Server.gs`, new `handlers/accounts.js`, `actions.js`, `demo-api.js` (demo mirror), xlsx/demo-data/SeedData Users sheet | M |
| 2 | **New login frontend.** Username/student-number field, real submit, forced change-password screen when `must_change_password`, Settings/Account page (all roles) for change password; admin forms: instructor = username + full name, student = student number + full name; "Reset password" buttons; remove Google wording (§4.1). | `index.html`, `login.js`, `auth.js`, `auth-forms.js`, `ui.js` (nav), new `*/settings.html`, `admin-*.js` | M |
| 3 | **Device API + session engine.** `device.submitScans` (1–20, `scan_id` idempotency, ScanLog every scan, session resolution arch §4.2 with lazy ClassSession creation, present/late via `late_grace_minutes`), `device.heartbeat`, `device.getRoster`; hashed device keys; all as WRITE under LockService; fix `SERVER_BUSY`. Test with curl/Postman before hardware. | `Server.gs` router (device auth path), new `handlers/device.js`, `handlers/sessions.js` | L |
| 4 | **Data correctness:** stop deleting/editing device Attendance rows (void/override columns); re-check schedule clash on class re-activate; re-enroll on section change; consistent `+08:00` timestamps. | `portal.js`, `classes.js`, `students.js`, `Server.gs` | M |
| 5 | **Hardware/software integration:** put firmware in `firmware/` (secrets ignored), implement 302→GET, LittleFS queue, NTP/backfill, feedback table; run the spec §9 checklist against the deployed API. Admin **Devices** page (register, assign room, generate/rotate key). | `firmware/`, new `admin/devices.html` + handler | L |
| 6 | **Security & access hardening:** SRI on CDN links, audit login/logout/reset events, CSV injection guard, Settings admin page (late grace, windows, battery threshold) with validation. | HTML heads, `Server.gs`, `attendance-ui.js`, new settings handler | S–M |
| 7 | **Optimization + reports:** per-action tab loading / `CacheService`; admin-wide reports & export; term archiving; a few Node unit tests for the handlers. | `Server.gs`, handlers, `tools/` | M |

---

## 8. Questions for you

1. Is `ALLOW_TEST_LOGIN` currently `true` in the deployed Apps Script project? Is the GitHub repo (`JezTheDev/RFID-Attendance-Monitoring-System`) **public**?
2. Where is `PROJECT_CONTEXT.md`? Can you add it to `docs/`?
3. Does firmware code exist somewhere (Jezreel's machine)? Should it live in this repo under `firmware/`?
4. Instructor username format — free text chosen by admin, or a rule (e.g., `jdelacruz`)? Must it be unique across students too?
5. Do we still need `email` for students/instructors at all (for contact only), or drop it from the forms?
6. How does the **bootstrap admin** get created — a one-time editor function that reads its password from Script Properties, then forces a change?
7. Lockout numbers: how many failed attempts, and for how long? Should admins be able to unlock manually?
8. Should a password reset by the admin go back to the *default* password (+ forced change), or generate a one-time random password shown once?
9. Minimum password rules (length, letters+numbers)?
10. Keep **demo mode** (fake data, no backend) for the defense/presentation, or remove it once live login works?
11. Attendance corrections: are admins also allowed (arch §7.1 says yes), or instructors only (current code)?
12. Student number format: is "exactly 10 digits" (`students.js:6`) the real PSU format?

---

## 9. Progress summary (paste into a new chat)

```
PROJECT: IoT RFID Attendance (ESP32+MFRC522 → Apps Script → private Google Sheets;
static Bootstrap frontend on GitHub Pages; roles admin/instructor/student).
Repo audited at commit bfdbb89 on 2026-11-18. Full report: docs/AUDIT_REPORT.md

LOGIN DECISION (overrides docs): NO Google Sign-In. Bootstrap admin; admin creates
all accounts; instructor = username + full name + default instructor password;
student = student number (username) + full name + default student password;
salted+hashed passwords, forced first-login change, admin reset, lockout,
defaults only in Script Properties. API: auth.login, auth.changePassword,
users.resetPassword, auth.logout, auth.me. auth.google REMOVED.

COMPLETED
- Apps Script backend: router, LockService on writes, atomic save, hashed session
  tokens (AuthSessions), role check on every request, setupSheets/setupViews.
- Shared handlers (frontend/assets/js/demo/handlers → Bundle.gs via
  tools/build_apps_script.mjs; verified in sync).
- Admin CRUD: students, RFID cards (assign/replace/revoke, unknown-UID picker),
  instructors, admins, terms, programs, sections, subjects, rooms, classes,
  schedules (room/instructor/section overlap check), enrollments. AuditLog writes.
- Admin dashboard (sessions, devices, battery/offline alerts, recent scans).
- Instructor portal: dashboard, sessions, attendance correction (reason+audit),
  roster, student history, class report + CSV export.
- Student portal: overview, history, profile. Ownership enforced server-side.

IN PROGRESS / PARTIAL
- Login page UI exists but is email-based and not wired (fake submit).
- ScanLog/AuditLog: written/read partly; no viewer pages.

PENDING
- New login system (all of it), Settings/change-password page.
- Device API (submitScans/heartbeat/getRoster), device keys, scan_id idempotency.
- Session engine (room+schedule+time, early window, present/late), manual
  start/extend/cancel. Admin Devices page, Settings page.
- Firmware (not in repo). PROJECT_CONTEXT.md missing.

KNOWN BUGS / RISKS
- CRITICAL: config.js has MODE live + real API URL + TEST_LOGIN true; if
  ALLOW_TEST_LOGIN=true on server, anyone can sign in as admin. Turn off now.
- Corrections delete/edit device Attendance rows (portal.js:353-357).
- Every request loads all tabs (slow as logs grow).
- Server error code BUSY vs spec SERVER_BUSY; server_time in UTC not +08:00.
- Section change doesn't update enrollments; class re-activate skips clash check.
- Docs/READMEs outdated (Google Sign-In, "backend not built", "portals not started").

KEY DECISIONS
- Server decides the session (not ESP32); one device per room.
- Absent is computed (enrolled − present/late), not stored.
- All Sheet cells plain text; dates YYYY-MM-DD, times HH:mm, Asia/Manila.
- Frontend → Apps Script via POST text/plain JSON; session token in body.
- Business logic written once in frontend/…/handlers, bundled into Bundle.gs.
```
