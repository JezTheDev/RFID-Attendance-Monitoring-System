# Student Frontend Audit

| | |
|---|---|
| Date | 2026-11-20 |
| Branch | `student-frontend` (from `main` @ `30a41ca`) |
| Scope | Student portal (`frontend/student/*`), its page scripts (`pages/student-dashboard.js`, `student-history.js`, `student-profile.js`) and the shared code they use (`api.js`, `auth.js`, `session.js`, `ui.js`, `components/attendance-ui.js`, `pages/account.js`, `pages/login.js`). Also the shared "Not yet" badge used by admin and instructor. |
| Method | Read every student page script and the matching backend (`backend/src/actions.js`, `handlers/portal.js` student section); compared action names, params, response fields, `not_scanned`, the `enrolled_at` rule and error codes. **Live check** against the deployed API (TEST Sheet), Node script: seeded student `9999000001` reset with `admin.resetPassword` (signed in as `admin.test`), temp password changed to a random one kept in memory only, never printed or saved. Both sessions logged out at the end. `admin.test`'s password was not changed. No browser run this time (see the end). |
| Changed | Nothing except this doc. |

**Legend:** **EXISTS** = works and matches the backend · **BROKEN** = there, but wrong or misleading · **MISSING** = not built.

**Bottom line:** Maayos ang 3 student pages: every call matches the backend, and ownership is solid. Live: another class gives `FORBIDDEN`, a `student_id` sent in the request is ignored, and every admin/instructor action gives `FORBIDDEN`. The gaps:
1. **MISSING: date filter (from/to) on History.** The backend supports it (live: `range` echoed, bad range gives `fields.to`), but the page sends only `class_id`.
2. **MISSING: My Account page** for students (change password while signed in). `pages/account.js` already works for any role, so this is only one HTML file and one nav item.
3. **Old wording:** the Late card hint says "Tapped after the grace period", but grace is gone (a tap is always PRESENT; late only comes from a correction). The shared badge says **"Not scanned yet"** where every other place says **"Not yet"**.
4. **Corrections:** only a "Corrected" tag. The reason is never shown because the backend does not send it to students. The tooltip says "Updated by your instructor", which is wrong when an admin made the correction.

---

## 1. Page map

| Page | File | Shows | Actions called | Matches backend? |
|---|---|---|---|---|
| My Attendance (overview) | `student/index.html` → `student-dashboard.js` | Greeting + "student no · section · term", 4 stat cards (overall rate, present, late, absent), below-80% warning, per-subject cards (rate meter, counts, schedule, "View history" link), today's classes, 6 recent records | `student.getOverview` (`:28`), no params | ✅ `profile`, `term_name`, `today_date`, `today[]`, `totals`, `subjects[]` (`classInfo` + `summarize`), `recent[]`. Live: OK (6 records, rate 0.83). `subjects[].last` and `range` are sent but not used (harmless). No `from`/`to` sent (fine for the overview: whole term). |
| Attendance History | `student/history.html` → `student-history.js` | Subject picker, status buttons (All/Present/Late/Absent), 4 summary tiles + meter, table (date, subject, class time, room, time in, status + Corrected/Manual tag), card list on mobile | `student.getHistory {class_id}` (`:59`) | ✅ `classes[]`, `records[]` (`status`, `scanned_at`, `manual`, `corrected`), `totals`. ❌ No `from`/`to` sent (backend accepts them). The status filter has no **Not yet** button (`:35`), so a `not_scanned` row only shows under "All". |
| My Profile | `student/profile.html` → `student-profile.js` | Avatar, name, number, account status; program, year & section, email; RFID card (masked UID `•••• 1234`, assigned date) or "no card"; username, account email, last sign-in; enrolled classes with schedule | `student.getProfile` (`:25`) | ✅ `profile.*`, `account.{username,email,last_login_at}`, `classes[]`. Live: no `hash` anywhere in the response. Read-only (no form, no write action). |
| My Account | — | — | — | **MISSING.** `ui.js:48-52` `NAVIGATION.student` has no Account item; there is no `student/account.html`. |
| Login + forced change | `index.html` → `login.js`, `auth-forms.js` (shared) | Student number + password; change-password step when `must_change_password` | `auth.login`, `auth.changePassword` | ✅ Live: temp login → `must_change_password: true`; `student.getOverview` before the change → `PASSWORD_CHANGE_REQUIRED`; after the change it works. |

**`phase` / `not_scanned` / `enrolled_at`:** student records carry no `phase` (backend sends `status` only: `present` / `late` / `absent` / `not_scanned` / `cancelled`). The `not_scanned` → `absent` switch at the session end happens on the server (`statusOf`), and sessions after which the student joined are dropped by `historyRows` (`statusFor(...) !== null`, `portal.js:654`). Totals exclude `not_scanned` and `cancelled` (`portal.js:706, :754`), so the page has nothing to compute. ✅ The pages use the server's numbers and do not count anything themselves.

### 1.1 Error codes

| Code | Handled? |
|---|---|
| `NOT_SIGNED_IN` (expired / revoked / fake token) | ✅ Once, in `api.js:34-44` → login with "Your session expired…". Live: after `auth.logout` and with a fake token → `NOT_SIGNED_IN`. The per-page checks (`student-dashboard.js:33`, `student-history.js:69`, `student-profile.js:27`) are dead code. |
| `PASSWORD_CHANGE_REQUIRED` | ✅ `api.js:37-39` + `requireRole` (`auth.js:57`) send the user to the change form. Seen live (server side). |
| `FORBIDDEN` (class not enrolled) | ✅ Server (live: `CLS-0007`, `CLS-0099`). ⚠️ UI `student-history.js:70-74` silently resets to "All subjects" with no message. Add a toast like IFIX-10. |
| `FORBIDDEN` (other role's actions) | ✅ Live: `instructor.getDashboard`, `instructor.correctAttendance`, `admin.listAttendance` → `FORBIDDEN`; `student.correctAttendance` → `UNKNOWN_ACTION`. |
| `VALIDATION_ERROR` on dates (`fields.from` / `fields.to`) | — Not reachable yet (no date inputs). Live server messages: bad range → `fields.to` "The end date must be on or after the start date."; bad date → `fields.from`. Use them when adding SFIX-03. |
| `NOT_FOUND` (no Students row) | ✅ Generic error card + Try again. |

---

## 2. MUST-HAVE checklist

### Overview (`student-dashboard.js`)
| Item | Status | Where / note |
|---|---|---|
| Attendance summary | EXISTS | `:45-48` stat cards; per subject `:64-88`. |
| Attendance percentage | EXISTS | `:45` `formatRate(totals.rate)`, per subject `:75`, meter `:79`. Below-80% warning `:50-54`. |
| Card hints | **BROKEN (wording)** | `:47` Late = "Tapped after the grace period" (grace is gone; late = corrected by instructor). `:46` Present = "On time" (OK but vague). `:48` Absent = "No tap recorded" (an absent can also be a correction). Suggest: Present "Tapped in", Late "Marked late by your instructor", Absent "Missed or marked absent". |
| Today's classes | EXISTS | `:99-119`. Live: none today. |
| Recent records | EXISTS | `:121-140`; `not_scanned` rows show the shared badge (see "Not yet"). |

### History (`student-history.js`)
| Item | Status | Where / note |
|---|---|---|
| Date + time of each scan | EXISTS | `:133` date, `:137` `scanned_at` ("—" for manual rows, by design: BACKEND_VERIFICATION S4). |
| Status | EXISTS | `:138` `attendanceBadge`. |
| Per class | EXISTS | Subject picker `:28-30`, `class_id` sent `:59`, kept in URL `?class=`. Overview "View history" links in `:84`. |
| Corrections shown | **BROKEN (partial)** | `:114-118` "Corrected" tag only, with tooltip "Updated by your instructor" (wrong if an admin did it). The reason is not shown: `historyRows` (`portal.js:658-672`) has `corrected` but no `correction_reason`. **Decision for the owner:** show the reason to students? Recommend yes (it is the instructor's note; `instructor.getSession` already returns it). Small backend change: add `correction_reason` to `historyRows` (also helps `instructor.getStudentHistory`). |
| Filter by date (from/to) | **MISSING** | `:59` sends no `from`/`to`. Backend ready (live). Same pattern as instructor IFIX-07: two `<input type="date">` in `#filterForm`, URL params, show `fields.*` under the inputs, "Whole term" reset. |
| "Not yet" filter | **MISSING (minor)** | `:35` buttons have no `not_scanned`; `:95` filter would match it if added. Show "Not yet" only when a record has it. |

### Profile (`student-profile.js`)
| Item | Status | Where / note |
|---|---|---|
| Student number, name | EXISTS | `:48-49`. |
| Program, section | EXISTS | `:55-56` (program code + name, year + section name). |
| Card status | EXISTS | `:59-69`: active card (masked UID) or "No RFID card…". Revoked/lost cards are not listed (backend sends only the active card); fine. |
| Read-only | EXISTS | No inputs, no write calls. Footer says to ask the admin (`:78`). |
| Account status | KEEP / minor | `:50` prints the raw value when not `active`. Practically unreachable (an inactive student's sessions are revoked). |

### My Account
| Item | Status | Note |
|---|---|---|
| Change password (role student) | **MISSING** | Copy `instructor/account.html` → `student/account.html` with `<body data-role="student">`, and add `{ section: 'Account', items: [{ id: 'account', label: 'My Account', icon: 'person-gear', href: 'student/account.html' }] }` next to My Profile in `ui.js` `NAVIGATION.student` (or put both in one Account section). `account.js` calls `auth.me` + `auth.changePassword`, both allowed for students. |

### Rules
| Item | Status | Note |
|---|---|---|
| Cannot edit attendance (UI) | EXISTS | No edit buttons or forms on any student page. |
| Cannot edit attendance (backend) | EXISTS | No `student.*` write action (`actions.js:188-193`); live `student.correctAttendance` → `UNKNOWN_ACTION`, `instructor.correctAttendance` → `FORBIDDEN`. |
| Cannot see other students (UI) | EXISTS | No student id anywhere in the UI; only `?class=`. |
| Cannot see other students (backend) | EXISTS | `linkedId(db, session, 'student')` (`portal.js:17`). Live: `student_id: 'STU-0002'` in the request → same 6 own records. Not-enrolled class → `FORBIDDEN`. |
| Session expiry | EXISTS | `api.js:34-44` + `session.js` `expires_at`. Remove the 3 dead checks. |
| First login forced password change | EXISTS | Shared login (`login.js:22`, `auth-forms.js:48`) + `requireRole` (`auth.js:57`). Live: OK. |

### "Not yet" wording (all portals)
| Where | Now | Status |
|---|---|---|
| `components/attendance-ui.js:8` `ATTENDANCE_STATUS.not_scanned` | "Not scanned yet" | **BROKEN** → "Not yet". Used by every `attendanceBadge` (student overview + history, instructor session view + history panel + recent activity, admin attendance). |
| `pages/instructor-reports.js:16` `MARK.not_scanned.label` | "Not scanned yet" (tooltip + legend) | **BROKEN** → "Not yet". |
| Admin dashboard (`admin-dashboard.js:144, :165`), admin report (`admin-attendance.js:436, :463`), instructor dashboard (`instructor-dashboard.js:167`), filters (`attendance-ui.js:59`), tiles (`instructor-attendance.js:239`) | "Not yet" / "not yet" | ✅ Already right. |

Only 2 strings to change; nothing else in `frontend/` says "Not scanned".

---

## 3. Unnecessary / leftovers

| Where | What | Recommend |
|---|---|---|
| `student-dashboard.js:33`, `student-history.js:69`, `student-profile.js:27` | `if (error.code === 'NOT_SIGNED_IN') return void requireRole('student')`: `api.js` already redirected. | DELETE (same as IFIX-04 for the instructor). |
| `student-dashboard.js:47` | "Tapped after the grace period" (`late_grace_minutes` was removed). | CHANGE wording (see 2). |
| `student-history.js:115` | `title="Updated by your instructor"` | CHANGE to "Corrected" + the reason (SFIX-05) or "Updated by your instructor or the admin". |
| `attendance-ui.js:8`, `instructor-reports.js:16` | "Not scanned yet" | CHANGE to "Not yet". |
| `student-dashboard.js` (unused) | `subjects[].last` from the backend is never read. | KEEP (backend field, harmless). |
| `frontend/README.md:45` | lists `student/ index, history, profile` | UPDATE when `account` is added. |
| Google / demo / default password / sign-up wording | None in student pages. | — |

---

## 4. Security

| Check | Result |
|---|---|
| Only own records | ✅ Identity from the session (`linkedId`), never the request. Live: `student_id` injection ignored; other class `FORBIDDEN`; admin/instructor actions `FORBIDDEN`. Tests: `portal.test.js` "student can only see their own data". |
| `escapeHtml` | ✅ Every server string is escaped (names, labels, room codes, subject titles, email, username, masked UID, option values in the class picker `:62`). Unescaped: `formatClockTime` output (`student-dashboard.js:106`, `student-history.js:149`): digits + AM/PM only (same finding as the instructor audit), and server counts. The greeting uses `textContent` (`student-dashboard.js:30`). No gap found. |
| Secrets | ✅ None. Only `API_URL`. Token in `sessionStorage` + POST body; the only URL params are `class`, `status`. The RFID UID is masked by the server (last 4 only). Live: no `hash` in `getProfile`. |
| Role check | ✅ `requireRole('student')` = navigation only; the server enforces the role. |

---

## 5. Fix plan

Ordered. Effort: **S** < 1 h · **M** half a day · **L** about a day. Frontend only unless stated.

| # | Task | Functions / files | Effort |
|---|---|---|---|
| **All batches DONE 2026-11-20** (SFIX-05 approved: role only, never the user id or name) | | | |
| **Batch 1: wording + cleanup** | | | |
| SFIX-01 ✅ | "Not yet" everywhere: `ATTENDANCE_STATUS.not_scanned.label` and `MARK.not_scanned.label`. | `attendance-ui.js`, `instructor-reports.js` | S |
| SFIX-02 ✅ | Overview card hints (Present / Late / Absent, no "grace period"). Delete the 3 dead `NOT_SIGNED_IN` checks. | `student-dashboard.js` `overviewHtml`, `start`; `student-history.js` `load`; `student-profile.js` `start` | S |
| **Batch 2: missing pieces** | | | |
| SFIX-03 ✅ | History From/To (+ "Whole term"): URL params `from`/`to` → `student.getHistory {class_id, from, to}`; show `range`; `fields.from`/`fields.to` under the inputs (`is-invalid`), never a stuck skeleton. | `student-history.js` `start`, `load` | M |
| SFIX-04 ✅ | My Account: `student/account.html` (`data-role="student"`) + nav item in `NAVIGATION.student`; README folder list. | new HTML, `ui.js`, `frontend/README.md` | S |
| **Batch 3: corrections + polish** | | | |
| SFIX-05 ✅ | Backend: `correction: {reason, at, by_role}` (`by_role` = "Instructor" / "Admin") on `historyRows` (`correctionOf`, `student-corrections.test.js`); note "The student can see this reason." in the instructor and admin correction dialogs. Was: (student history + instructor student history); test that it is the row's `override_reason` and own rows only. Frontend: show it in the Corrected tag tooltip + a small line on mobile; neutral wording "Corrected". Build + `npm test`. | `portal.js` `historyRows`, `portal.test.js`; `student-history.js` `historyHtml` (`note`); `instructor-history.js` (optional) | S |
| SFIX-06 ✅ | "Not yet" status button in History when any record is `not_scanned`. `FORBIDDEN` class deep link: warning toast before falling back to All subjects. | `student-history.js` `start`, `historyHtml`, `load` | S |

Not done in this audit: no browser run (layout at 375 px / 1366 px was not looked at this time; the pages use the same components as the instructor portal, which passed at both widths). The TEST student had no `not_scanned`, `cancelled`, corrected or manual record, so those badges and tags were checked in code only. After the live check, `9999000001`'s password is a random one nobody knows; use `resetTestUserPassword('9999000001')` or `admin.resetPassword` to sign in as that student again.
