# Admin Frontend Audit

| | |
|---|---|
| Date | 2026-11-20 |
| Branch | `admin-frontend` |
| Scope | Login page (`frontend/index.html`) + Admin portal (`frontend/admin/*`), the shared JS they use (`api.js`, `auth.js`, `session.js`, `ui.js`, `auth-forms.js`, `components/*`) and the CSS. Instructor/student pages: NOT reviewed. |
| Method | Read every admin page script and the matching backend handler (`backend/src/actions.js` + `handlers/*`); compared action names, params, response fields and error codes. Browser check (Playwright, local `python -m http.server`) at 375 px and 1366 px against the **live** API with a fake session token (no real sign-in, no password used, no Sheet writes). |
| Changed | Only `frontend/assets/js/config.js` `API_URL` (commit `b11b536`). Nothing else. |

**Legend:** **EXISTS** = works and matches the backend · **BROKEN** = there, but wrong or misleading · **MISSING** = not built.

**Bottom line:** Login + the 6 existing admin pages are in good shape and match the backend almost 1:1. The big gaps:
1. **Expired session does not send you back to login** (stuck skeleton on Dashboard, "Try again" loop on the other pages). Seen live.
2. **No reset password / unlock buttons** anywhere. For students and instructors the backend list/detail responses **do not include `user_id`**, which `admin.resetPassword` / `admin.unlockUser` need, so this needs a **small backend change first** (see FIX-04).
3. The 4 new pages (Devices, Attendance, Settings, My account) do not exist yet. The backend for all of them is done.

---

## 1. Page map

### 1.1 Login: `index.html` + `auth-forms.js` + `pages/login.js`

| Shows | Calls | Matches backend? |
|---|---|---|
| Sign in (username or student number + password), "Forgot password?" info view (no email reset, ask the admin), forced change-password form | `auth.login {username, password}` → saves `session_token, user_id, username, role, display_name, email, must_change_password, expires_at` in **sessionStorage** (`auth.js:20-35`) | ✅ Same field names as `account.login` (`account.js` return). |
| | `auth.changePassword {old_password, new_password}` | ✅ `VALIDATION_ERROR` `fields.old_password` / `fields.new_password` → `auth-forms.js:24-27` shows the first field message. ✅ |
| | `auth.logout` (from `ui.js` sign-out) | ✅ |
| Errors | `TEMP_PASSWORD_EXPIRED` → special message (`auth-forms.js:20-22`) | ✅ |
| | `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED`, `ACCOUNT_DISABLED`, `SERVER_BUSY`, `NOT_CONFIGURED` | ✅ Server message shown as-is (good, the messages are user-friendly). |

Notes: `must_change_password` → change form opens straight away with the old password pre-filled (`auth-forms.js:48-53`); reload resumes it (`login.js:349`). Client checks only length ≥ 8; the "letters + numbers" rule is enforced by the server. Fine.

### 1.2 Admin pages

| Page | File | Shows | Actions called | Matches backend? |
|---|---|---|---|---|
| Dashboard | `admin/index.html` → `pages/admin-dashboard.js` | Date picker, 4 stat cards, "Needs attention" alerts, class sessions of the day, devices, 10 recent scans | `admin.getDashboard {date}` | ✅ Fields match (`stats.*`, `sessions[]`, `devices[]`, `recent_scans[]`, `alerts[]`). ⚠️ Ignores `sessions[].phase` and `not_scanned` (see 2 and BROKEN items). |
| Students & Cards | `students.html` → `admin-students.js` | Server-paged list + filters, details offcanvas, add/edit, assign/replace/revoke card, activate/deactivate | `admin.getStudentOptions`, `listStudents {search, section_id, status, card, page, page_size}`, `getStudent`, `createStudent`, `updateStudent`, `assignCard {student_id, rfid_uid, replace_reason, note}`, `revokeCard {student_id, reason}`, `setStudentStatus {student_id, status, reason}`, `listUnregisteredUids` | ✅ All params and fields match. `temp_password` modal ✅. `enrollment_changes` ✅ (toast only). |
| Instructors | `instructors.html` → `admin-instructors.js` (resource-manager) | Client-filtered list, add/edit, activate/deactivate, links to Classes | `admin.listInstructors`, `createInstructor`, `updateInstructor`, `setInstructorStatus {instructor_id, status}` | ✅ `locked`, `must_change_password`, `class_count` used. `IN_USE` (has active classes) shown in the modal. |
| Administrators | `admins.html` → `admin-admins.js` (resource-manager) | List with "You" badge, add/edit, activate/deactivate | `admin.listAdmins`, `createAdmin`, `updateAdmin`, `setAdminStatus {user_id, status}` | ✅ Self / last-admin `IN_USE` shown in the modal. |
| Academic Setup | `academic.html` → `admin-academic.js` (5 tabs on resource-manager) | Terms (+ set active), Programs, Sections, Subjects, Rooms | `admin.list/create/update*` for each; `setActiveTerm`; `set{Program,Section,Subject,Room}Status` | ✅ Field names match `academic.js` (`term_name/start_date/end_date`, `program_code/name`, `program_id/year_level/section_name`, `subject_code/title/units`, `room_code/name/building`). Terms have no status action (correct, backend has none). |
| Classes & Schedules | `classes.html` → `admin-classes.js` | Term filter, client search/status, details offcanvas: schedule, students, add/drop | `admin.getClassOptions`, `listClasses {term_id}`, `getClass`, `createClass`, `updateClass {class_id, instructor_id}`, `setClassStatus`, `addSchedule {class_id, day_of_week, start_time, end_time, room_id}`, `removeSchedule`, `enrollStudents {class_id, student_ids[]}`, `dropEnrollment {class_id, student_id, reason}` | ✅ Schedule clash comes back as `fields.start_time` → shown under Start. Activate clash (`VALIDATION_ERROR`, "Cannot activate: …") → shown in the confirm modal's error box. |

### 1.3 Error-code handling across admin pages

| Code | Handled? |
|---|---|
| `VALIDATION_ERROR` + `fields` | ✅ `openFormModal` → `showFieldErrors` puts each message under its input (`ui.js:288-302, 349`) + the message in the alert box. |
| `NOT_SIGNED_IN` (expired / revoked token) | **BROKEN.** Dashboard calls `requireRole('admin')` (`admin-dashboard.js:67-70`) but the stale session is still in sessionStorage, so nothing happens → **skeleton forever** (seen live at 375 px). All other pages show "Something went wrong / Try again" + a toast (seen live), which loops. Fix once in `api.js`: on `NOT_SIGNED_IN` → `clearSession()` + go to `index.html`. |
| `PASSWORD_CHANGE_REQUIRED` | ⚠️ Not handled. Only happens if the stored session is out of date. Same fix as above (send to login, which resumes the change form). |
| `SERVER_BUSY` | ⚠️ Shown as a normal error with the server text ("The server is busy. Please try again."). OK for now; nice-to-have: one automatic retry for reads. |
| `IN_USE`, `NO_CHANGE`, `NOT_FOUND`, `STUDENT_INACTIVE`, `CLASS_INACTIVE` | ✅ Message shown in the modal. |
| `TEMP_PASSWORD_EXPIRED` | ✅ Login only (correct, it's a login error). |

---

## 2. MUST-HAVE checklist

### Dashboard (`admin-dashboard.js`)
| Item | Status | Where / note |
|---|---|---|
| Total students | EXISTS | `:142` shown as the hint "of N active students", not as its own card. OK, or give it a card in polish. |
| Total instructors | EXISTS | `:144` hint text only ("· N instructors"). Same remark. |
| Present today | EXISTS | `:142` `stats.students_present`. |
| Attendance stats | EXISTS | `:139-143` rate + per-session present/late/absent. |
| Session status label | **BROKEN** | `:8-15` maps `session.status`. Sessions are never set to `closed` (by design, ended = computed), so a finished class still shows **"Open"**. Use `row.phase` (`upcoming / in_progress / ended / cancelled`). |
| Not-scanned count | **BROKEN** | Table has Present/Late/Absent only (`:179`). While a class runs, students who haven't tapped are in `not_scanned`, so the numbers don't add up to `enrolled`. Add a "Not yet" column (or bar segment). |
| Device status + low-battery alerts | EXISTS | `:244-272` devices card (online, battery, queue, last seen) + alerts from the backend (`:149-166`). |
| Recent scans | EXISTS | `:274-306` latest 10 for the date. |

### Students (`admin-students.js`)
| Item | Status | Where / note |
|---|---|---|
| Create (student number + name → temp password modal) | EXISTS | `:337-352`, `showTempPassword` (`ui.js:385`). Shown once, copy button, static backdrop. |
| Edit | EXISTS | `:354-376`. ⚠️ If the student's section is now inactive, the select has no matching option and save fails with "Choose a section." Edge case, low. |
| Section-change summary | EXISTS (weak) | `:370-373` dropped/enrolled class labels in a **toast** (4.5 s, easy to miss). Show it in a small result modal. |
| Card assign / replace / revoke | EXISTS | `:378-458`. Replace asks `replace_reason` (lost/damaged/other) ✅. |
| Unregistered-UID picker | EXISTS | `:393-401, 432-436` click a recent unknown tap to fill the UID. |
| Reset password | **MISSING** | Needs `user_id`; `admin.getStudent` → `account` has no `user_id` (`accountSummary` in `admin-users.js`). **Backend change needed** (FIX-04). |
| Unlock | **MISSING** | Same as above. Lock status is already shown (`:288`). |

### Instructors (`admin-instructors.js`)
| Item | Status | Where / note |
|---|---|---|
| Create (username + name → temp password) | EXISTS | resource-manager `:147-153` passes `username` into `showTempPassword`. |
| Edit | EXISTS | |
| Reset | **MISSING** | `listInstructors` items have no `user_id` (backend). FIX-04. |
| Unlock | **MISSING** | Same. "Locked" badge already shown (`:239`). |

### Admins (`admin-admins.js`)
| Item | Status | Where / note |
|---|---|---|
| Create backup admin | EXISTS | Temp password modal ✅. |
| Reset | **MISSING** | `user_id` is in the list ✅, only the button is missing. Hide it on your own row (backend refuses: "Use Change password…"). |
| Unlock | **MISSING** | Same, no backend change needed. |
| Status (activate/deactivate) | EXISTS | Self / last-admin errors shown. |

### Academic (`admin-academic.js`)
| Item | Status |
|---|---|
| Terms (create, edit, set active) | EXISTS |
| Programs | EXISTS |
| Sections | EXISTS |
| Subjects | EXISTS |
| Rooms | EXISTS (shows the room's `device_id`). ⚠️ Text says "Devices are assigned to rooms on the Devices page" (`:128`): that page does not exist yet. |

### Classes (`admin-classes.js`)
| Item | Status | Note |
|---|---|---|
| Schedules with clash errors shown | EXISTS | `:329-355`; clash text under Start (`fields.start_time`). |
| Enrollments (add / drop with reason) | EXISTS | `:372-434`. |
| Activate / deactivate with clash error shown | EXISTS | `:311-327`; the `VALIDATION_ERROR` message ("Cannot activate: …") shows in the modal's alert box. `fields.status` has no input, so nothing under a field. Fine. |

### Devices page (NEW)
| Item | Status | Backend ready |
|---|---|---|
| Register (`createDevice {device_name, room_id, notes?}`) | MISSING | ✅ |
| Assign room (`assignDeviceRoom`, `room_id: ''` = unassign) | MISSING | ✅ |
| Generate key shown once (`generateDeviceKey` → `device_key`) | MISSING | ✅ Reuse the `showTempPassword` pattern (static modal, DOM only, removed on close). |
| Activate (needs key: `NO_DEVICE_KEY`; one per room: `ROOM_HAS_ACTIVE_DEVICE`) | MISSING | ✅ |
| Retire (final, `DEVICE_RETIRED` afterwards) | MISSING | ✅ |
| Battery / online / queue status | MISSING (on Dashboard only) | `listDevices` gives the raw row (+ `has_key`); online/low_battery are computed only in `deviceSummaries` (dashboard / report). Either compute online on the client from `last_seen_at` + setting, or call `admin.getAttendanceReport`'s `devices`. Decide in FIX-08. |

### Attendance page (NEW)
| Item | Status | Backend ready |
|---|---|---|
| `admin.listAttendance` filters (class, section, student, status) + date range + paging (`page_size` ≤ 500, `total`) | MISSING | ✅ |
| `admin.correctAttendance {session_id, student_id, status, reason}`, reason required, BUG-6 message ("no tap… counted as absent automatically") shown | MISSING | ✅ The BUG-6 message comes in `fields.status`, so the form needs a `status` input for `showFieldErrors` to place it. `SESSION_NOT_STARTED`, `SESSION_CANCELLED`, `NOT_ENROLLED` → modal alert. |
| `admin.getAttendanceReport {group_by, from, to, class_id?, section_id?}` | MISSING | ✅ Also shows `pending_offline_scans`. |
| CSV export (escape cells starting with `= + - @`) | MISSING | Frontend only. Check `instructor-reports.js` for an existing CSV helper to reuse (not audited here). |

### Settings page (NEW)
| Item | Status | Backend ready |
|---|---|---|
| `admin.getSettings` (10 keys with `description, min, max, decimal`) | MISSING | ✅ |
| `admin.updateSettings {changes}` all-or-nothing, `fields` by key | MISSING | ✅ `showFieldErrors` works if each input's `name` = the key. |
| Shows ranges | MISSING | Use `min`/`max`/`decimal` from the response. |
| Sends trimmed numbers | MISSING | **Must trim**: `parseValue` (`settings.js:34-41`) does not trim, so `" 5"` is refused. Send only changed keys. |

### My account
| Item | Status | Note |
|---|---|---|
| Change own password | **MISSING** | The user menu (`ui.js:150-154`) has only the username + Sign out. `auth.changePassword` + `ApiError.fields` already work; add a "Change password" item that opens `openFormModal`. After success, the backend revokes OTHER sessions only, so the current one stays valid. |
| Forced change on first login | EXISTS | `index.html:62-97`, `auth-forms.js:48-53, 59-67`. |

---

## 3. Unnecessary / leftovers

| Where | What | Recommend |
|---|---|---|
| `assets/css/auth.css:2` | Header comment says "sign in / **sign up** / forgot password" | DELETE the word (no sign-up). |
| `assets/css/auth.css:47-52, 80, 94, 115, 138-147, 148 (signup half of the selector), 251, 787-789` | `.auth-pane--signup`, `.auth-face--signup`, `[data-mode="signup"]`, `#signUpForm`: the old sign-up pane. No HTML uses it. | DELETE. |
| `assets/css/auth.css:372-376` `.auth-row`, `:378-421` `.auth-segment*` + `#suTypeInstructor` (sign-up account-type switch), `:423-448` `.auth-strength*` (password meter), `:458-498` `.auth-check*`, `:605-615` `.auth-btn--ghost`, `:625` `.bi-send` hover, `:673-692` `.auth-divider` (the old "or continue with Google" divider) | Not used by any HTML or JS. | DELETE. (`.auth-strength` could be KEPT if you want a strength meter on the change-password form; otherwise delete.) |
| `assets/css/app.css:590-602` `.hero-points`, `:604-610` `.login-form` | Old login layout, unused. | DELETE. |
| `assets/js/auth-forms.js:92` | Comment "old #signup links land on sign in". | KEEP (harmless redirect for old bookmarks), or delete the comment. |
| `assets/js/bubbles.js:5` | `LOGO_SRC = 'assets/img/logo.png'`, but **the file does not exist** → 404 on every login load (seen in the console). | Add the logo or DELETE the image from the bubbles. |
| `/favicon.ico` | 404 on every page. | Add one small favicon (or a `<link rel="icon">` data URI). |
| `admin-students.js:288` | "Password: **Default (not changed yet)**": the default-password era. | Change to "Temporary password (not changed yet)". |
| `admin-students.js:325` | Help text example used what looks like a real student number. | Replace with an obviously fake one. **Done in Batch 1** (`2026000001`). |
| `admin-dashboard.js:9-15` | `SESSION_STATUS.closed` / `scheduled` never come from the backend for real sessions; `open` is shown after the class ends. | Replace with a `phase` map (see Dashboard BROKEN). |
| `admin-academic.js:128` | Mentions a "Devices page" that does not exist yet. | KEEP; it becomes true after FIX-08. |
| `ui.js:371` | Reason textarea `maxlength="200"`, backend allows 500 (`MAX_TEXT`). | KEEP (stricter is safe), or raise to 500 for consistency. |
| Google / demo / late-grace | None found in admin pages, login HTML or shared JS. `late` still appears only as a status (corrections can still set late), which is correct. | — |

Fields the backend no longer accepts: none sent by admin pages. Every request body matches the handler's input names.

---

## 4. UI / UX

| Area | Finding |
|---|---|
| Broken links | None among the 6 nav items (all files exist). The 4 new pages need nav entries in `ui.js:4-22` (`NAVIGATION.admin`). Suggested groups: **Overview** (Dashboard, Attendance), **People**, **Academic**, **System** (Devices, Settings). |
| Loading states | ✅ Skeletons on every list/detail. ⚠️ Students subtitle stays "Loading…" if the list fails (`admin-students.js:29`). |
| Error states | ✅ `errorStateHtml` + Try again everywhere. ❌ No sign-in redirect on `NOT_SIGNED_IN` (section 1.3). |
| Empty states | ✅ Every list ("No students yet", "No classes in this term yet", "No devices registered", …). |
| Mobile 375 px | ✅ Login fits, no horizontal scroll (checked live). ✅ Dashboard + Students: no horizontal scroll, off-canvas sidebar, columns hide below sm/md/lg, dashboard sessions switch to cards below md. ⚠️ The details offcanvas is 440/520 px wide; on a phone Bootstrap caps it at the viewport, OK. |
| Desktop 1366 px | ✅ Clean layout (checked Students live). |
| Navigation consistency | ✅ All admin pages use `renderShell` + the same `page-header`. ⚠️ Students and Classes have their own list code; Instructors/Admins/Academic use `resource-manager`. Fine, Students needs server paging. |
| Design consistency | ✅ Same badges, cards, modals, toasts. ⚠️ Status badges: `resource-manager.statusBadge` vs dashboard `badge()` vs `components/attendance-ui.js` `badge`: 3 small helpers for the same thing. Merge in polish (optional). |
| Feedback that disappears | Section-change result and "card revoked" are toasts only (4.5 s). |
| Accessibility | ✅ aria-labels on icon buttons, `aria-current`, focus moves into modals. |

---

## 5. Security

| Check | Result |
|---|---|
| No secrets in frontend code | ✅ Only `API_URL` (public by design). No passwords, keys or pepper. |
| Tokens not in URLs | ✅ Token in the POST body (`api.js:15`) and in **sessionStorage** (`session.js`). URL params used: `term`, `class`, `q`, `assign` only. |
| Temp password / device key handling | ✅ `showTempPassword` keeps it in the modal DOM only, removed on close, never in a toast or storage (`ui.js:383-434`). Reuse it for `device_key`. |
| `escapeHtml` on all data | ✅ Almost everything. Small gaps (server-validated values, but a hand-edited Sheet cell could still inject HTML): `admin-academic.js:112` `row.units` (raw Sheet cell); `admin-classes.js:122` `s.day`, `s.start_time`, `s.end_time`; `formatClockTime(...)` output in `attendance-ui.js:93` and the dashboard. Wrap them in `escapeHtml` (cheap). Numbers computed by the server (`count`, `enrolled`) are safe. |
| Role checks | ✅ `requireRole('admin')` on every page is navigation only; the server enforces roles. |
| CSV injection | N/A yet; required for FIX-10 (`= + - @`, and also leading tab/CR if you want to be strict). |
| Personal data in code | ⚠️ `admin-students.js:325` example number (section 3). |

---

## 6. Fix plan

Ordered by priority. Effort: **S** < 1 h · **M** half a day · **L** about a day.

| # | Task | Files | Effort |
|---|---|---|---|
| **P1: login + navigation** | | | |
| FIX-01 | `callApi`: on `NOT_SIGNED_IN` or `PASSWORD_CHANGE_REQUIRED` → `clearSession()` + redirect to `index.html` (one place). Remove the per-page `NOT_SIGNED_IN` check. | `api.js`, `admin-dashboard.js:67-70` | S |
| FIX-02 | Add nav entries for Attendance, Devices, Settings (pages can start as a "coming soon" state until built, or add each with its page). | `ui.js` | S |
| FIX-03 | Login leftovers: missing `logo.png` / favicon 404s, delete dead sign-up/Google CSS. | `bubbles.js`, `auth.css`, `app.css`, `index.html` | S |
| **P2: existing pages** | | | |
| FIX-04 | **Backend:** add `user_id` to `accountSummary` (`admin-users.js`) so `listInstructors` items and `getStudent.account` carry it; test that no hash leaks. Rebuild Bundle.gs + redeploy. | `backend/src/auth/admin-users.js`, tests | S |
| FIX-05 | Reset password + Unlock buttons on Students (details panel), Instructors, Admins (not on your own row) → `admin.resetPassword` → `showTempPassword`; `admin.unlockUser` only when `locked`. | `admin-students.js`, `admin-instructors.js`, `admin-admins.js`, `resource-manager.js` (extraActions already supported) | M |
| FIX-06 | Dashboard: status from `phase`; add a not-scanned count; give total students / instructors their own stat cards (optional). | `admin-dashboard.js` | S |
| FIX-07 | Students: "Temporary password" wording, fake example number, section-change result modal instead of toast, subtitle on list error. | `admin-students.js` | S |
| FIX-07b | `escapeHtml` gaps (units, schedule day/time, `formatClockTime` output). | `admin-academic.js`, `admin-classes.js`, `attendance-ui.js`, `admin-dashboard.js` | S |
| **P3: new pages** | | | |
| FIX-08 | **Devices page**: list (`has_key`, room, status, battery, last seen, queue), register, edit, assign/unassign room, generate key (shown once), set status active/maintenance/retired with the error messages. | new `admin/devices.html`, `pages/admin-devices.js` | M |
| FIX-09 | **Settings page**: form from `getSettings` (range hint per key), send only changed keys, **trimmed**, field errors by key, note when `roster_version_bumped`. | new `admin/settings.html`, `pages/admin-settings.js` | S |
| FIX-10 | **Attendance page**, part 1: `listAttendance` table with filters (date range, class, section, student, status) + paging + correction modal (`correctAttendance`, reason required, `status` input so the BUG-6 message lands under it). | new `admin/attendance.html`, `pages/admin-attendance.js` | L |
| FIX-11 | **Attendance page**, part 2: Report tab (`getAttendanceReport`, group by class / section / student, devices + pending offline scans) + CSV export with formula escaping (one small helper + a tiny test). | same + CSV helper | M |
| FIX-12 | **My account**: "Change password" in the user menu → modal → `auth.changePassword`. | `ui.js` | S |
| **P4: polish** | | | |
| FIX-13 | One shared status-badge helper; `SERVER_BUSY` auto-retry once for reads; reason `maxlength` 500. | `ui.js`, components | S |
| FIX-14 | Full 375 px pass on the 4 new pages + signed-in check of every page against the live API (needs an admin sign-in: **ask the owner**). | — | S |

Not done in this audit: a real signed-in run (I used a fake token only, so lists with real data were not seen live); instructor/student portals.
