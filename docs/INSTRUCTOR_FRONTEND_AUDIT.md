# Instructor Frontend Audit

| | |
|---|---|
| Date | 2026-11-20 |
| Branch | `instructor-frontend` (from `main` @ `02679a4`) |
| Scope | Instructor portal (`frontend/instructor/*`), its page scripts (`pages/instructor-dashboard.js`, `instructor-attendance.js`, `instructor-history.js`, `instructor-reports.js`) and the shared code they use (`api.js`, `auth.js`, `session.js`, `ui.js`, `components/attendance-ui.js`, `pages/account.js`). Admin and student portals: NOT reviewed. |
| Method | Read every instructor page script and the matching backend (`backend/src/actions.js`, `handlers/portal.js`); compared action names, params, response fields, `phase` / `not_scanned` and error codes. **Live check** against the deployed API (TEST Sheet): `instructor01.test` reset with `admin.resetPassword` (signed in as `admin.test`), temp password changed to a random one kept in memory only, never printed or saved. Browser (Playwright, local `python -m http.server`) at 375 px and 1366 px. Signed out at the end (token revoked). `admin.test`'s password was not changed. |
| Changed | Nothing except this doc. |

**Legend:** **EXISTS** = works and matches the backend · **BROKEN** = there, but wrong or misleading · **MISSING** = not built.

**Bottom line:** The 3 instructor pages work and every call matches the backend's names and params. Ownership is solid (live: another instructor's class → `FORBIDDEN` on all 4 class actions). Session expiry is handled (Batch 1 fix in `api.js` applies, seen live). The gaps:
1. **`phase` is ignored everywhere.** Real sessions (made by a device tap) stay `status: open` forever, so a finished class still reads **"Open"**, the session picker shows the raw word `open`, and the **Absent filter becomes "Not scanned"** even after the class ended. The TEST Sheet hides this because its seeded sessions are `closed`.
2. **No "Not yet" count** on the dashboard or the session tiles, so during class Present + Late + Absent ≠ enrolled.
3. **MISSING:** recent-activity widget (`instructor.getRecentActivity` is never called), My Account page, and date filters on the Attendance page and the student history panel (only Reports has them).
4. Two dead ends seen live: a bad date range on first load leaves Reports on a **skeleton forever**, and a deep link to a class that isn't yours leaves the class picker on **"Loading…"**.

---

## 1. Page map

| Page | File | Shows | Actions called | Matches backend? |
|---|---|---|---|---|
| Dashboard | `instructor/index.html` → `instructor-dashboard.js` | Greeting, date picker (prev/next/today), 4 stat cards (classes, students, sessions on this day, term attendance), "My sessions" for the date, "Needs follow-up" (below 80%), class cards (schedule, students, rate, buttons to Students / Attendance / Report) | `instructor.getDashboard {date}` (`:46`) | ✅ Fields match (`stats.*`, `sessions[]`, `classes[]`, `watchlist[]`, `in_term`, `term_name`). Live: OK. ❌ Uses `row.status` (`:143`), not `row.phase`; ignores `not_scanned` (`:130`). |
| Attendance (live session view) | `attendance.html` → `instructor-attendance.js` | Class + session pickers, summary tiles, status filter, search, roster table with Correct button | `instructor.listSessions {class_id}` (`:59`), `instructor.getSession {session_id}` (`:109`), `instructor.correctAttendance {session_id, student_id, status, reason}` (`:277-279`) | ✅ Names, params and fields match. ❌ No `from`/`to` sent (backend supports them). ❌ `status` used where `phase` is needed (`:90, :175, :186`). |
| Class roster / student history (side panel) | `instructor-history.js` (used by all 3 pages) | Roster: students, section badge when from another section, "no RFID card", rate. History: one student's sessions in that class, rate tiles | `instructor.getClassRoster {class_id}` (`:49`), `instructor.getStudentHistory {class_id, student_id}` (`:96`) | ✅ Fields match (`other_section`, `has_card`, `records[].status/scanned_at/corrected/manual`, `totals`). `cancelled` and `not_scanned` statuses have badges. ❌ No `from`/`to`. |
| Class Reports | `reports.html` → `instructor-reports.js` | Class picker, From/To + "Whole term", header (instructor, range, generated), 4 stat cards, per-student table, session-by-session matrix, Print, Export CSV | `instructor.getClassReport {class_id, from, to}` (`:76`) | ✅ `range`, `generated_at`, `cancelled_sessions`, `students[].marks` (incl. `null` = joined later, `:16`), `totals`. Live: OK. `fields.to` handled (`:98-101`) but see BROKEN. |
| My Account | — | — | — | **MISSING.** Nav has no entry (`ui.js:37-46`), no `instructor/account.html`. |

### 1.1 Error codes

| Code | Handled? |
|---|---|
| `NOT_SIGNED_IN` / `PASSWORD_CHANGE_REQUIRED` | ✅ Once, in `api.js:34-44` (`leaveIfSignedOut`). **Seen live:** fake token on Reports → back to login with "Your session expired, please sign in again." The per-page checks (`instructor-dashboard.js:51-54`, `instructor-attendance.js:96`, `instructor-reports.js:97`) are now dead code. |
| `FORBIDDEN` (not your class) | ✅ Server refuses (live). ⚠️ UI: error state + "Try again" that repeats the same refusal, class picker stuck on "Loading…" (seen live, `?class=CLS-0003`). |
| `VALIDATION_ERROR` on correction (`fields.status`, `fields.reason`) | ✅ Modal has `name="status"` radios + `data-error-for="status"` (`instructor-attendance.js:262-265`) and `reason` (`:268-269`), so `showFieldErrors` puts the message under the field. |
| BUG-6 ("no tap … counted as absent automatically") | ✅ Comes as `fields.status` → shown under the radios. Also prevented up front: Absent is disabled for a `not_scanned` student (`:249, :262`). |
| `SESSION_NOT_STARTED` | ⚠️ Works (message in the modal's alert box), but the Correct button is still shown for an `upcoming` session (early tap). Hide it on `phase === 'upcoming'`. |
| `SESSION_CANCELLED` | ✅ Correct button hidden for cancelled (`:225`), banner shown (`:189`). |
| `CLASS_INACTIVE` | ⚠️ Message shows in the modal alert (generic path). Practically unreachable: `listSessions` / `getClassReport` / dashboard list only **active** classes (`myClasses`, `portal.js:213-217`), so an archived class is visible only via a hand-typed URL. There is no read-only UI state. |
| `NOT_ENROLLED`, `NOT_FOUND` | ✅ Message in modal / panel error state. |
| `VALIDATION_ERROR` on dates (`fields.from` / `fields.to`) | ⚠️ Reports: `fields.to` → toast only; `fields.from` → generic error card. **BROKEN on first load** (see 2). |

---

## 2. MUST-HAVE checklist

### Dashboard (`instructor-dashboard.js`)
| Item | Status | Where / note |
|---|---|---|
| Assigned classes | EXISTS | `:183-218` class cards; stat card `:107`. |
| Students per section | EXISTS | `:199, :202` `subject_code · section_label` + "N students"; roster panel per class. |
| Present / absent counts | EXISTS | `:128-131` per session; `:110` term rate. |
| "Not yet" count | **BROKEN** | `:130` shows present/late/absent only. While class runs, `not_scanned` students are missing, so the numbers don't add up to "of N". Add `<span>N not yet</span>` (backend sends `not_scanned`). |
| Session status label | **BROKEN** | `:143` `sessionBadge(row.status)`. Held sessions are `open` forever (by design), so a finished class reads "Open". Use `row.phase` like the admin dashboard (`admin-dashboard.js:9-21`). |
| Recent attendance activity | **MISSING** | `instructor.getRecentActivity` is not called anywhere. Backend ready (`{limit, has_more, items[]}` with `student_name`, `class_label`, `scanned_at`, `status`, `source`, `sync_mode`, `corrected`; live: OK). |
| Needs follow-up | EXISTS | `:159-181` watchlist (below 80%, ≥ 2 sessions). |
| Mobile 375 px | EXISTS | Live: no horizontal scroll. |

### Live session view (`instructor-attendance.js`)
| Item | Status | Where / note |
|---|---|---|
| Who tapped (+ time in, offline-sync tag, corrected tag) | EXISTS | `:226-241`. |
| "Not yet" during class | **BROKEN** | Filter label/count switch on `info.status === 'open'` (`:175`). Real sessions are always `open`, so after the class ends the button still says "Not scanned" and counts `not_scanned` = 0 while students are `absent`. During class, an explicit absent override and not-yet students are lumped into one button. Use `phase`: show **Not yet** and **Absent** as separate filters when `in_progress` / `upcoming`. |
| Absent only after it ends | **BROKEN (display)** | Backend is right (`statusFor`). The page: summary tiles `:191-196` have no "Not yet" tile, and the header badge `:186` says "Open" after the end. |
| Session picker label | **BROKEN** | `:90` `row.status === 'closed' ? 'x/y attended' : row.status` → every real session shows the raw word **"open"**. (Live TEST data is seeded `closed`, so it looked fine there.) Build the label from `phase` + counts. |
| Date filter on class history | **MISSING** | `:59` sends only `class_id`; backend accepts `from`/`to` and echoes `range`. A class with a full term of sessions is one long `<select>`. |
| Correct button for upcoming session | **BROKEN (minor)** | `:225` shows it; server refuses with `SESSION_NOT_STARTED`. Hide when `phase === 'upcoming'`. |

### Student history (`instructor-history.js`)
| Item | Status | Where / note |
|---|---|---|
| Own classes only | EXISTS | Opened only from own roster / report rows; server `ownClass` + `NOT_ENROLLED` (`portal.js:557-566`). |
| Date filters | **MISSING** | `:96` sends no `from`/`to`; `getClassRoster` (`:49`) also none. Simplest: pass the page's current range (Reports already has one) and show it in the panel. |

### Correct attendance (`instructor-attendance.js:244-285`)
| Item | Status | Where / note |
|---|---|---|
| Reason required | EXISTS | `required minlength="5"` (`:268`), server checks too. ⚠️ `maxlength="200"`; backend allows 500 (`MAX_TEXT`), admin modal uses 500. Align to 500. |
| BUG-6 message | EXISTS | See 1.1. |
| `CLASS_INACTIVE` / read-only inactive class | EXISTS (generic) | See 1.1. No read-only view because inactive classes are not listed at all. **Decision for the owner:** keep (archived classes invisible to instructors) or add a backend option to list inactive classes read-only. |
| `SESSION_NOT_STARTED` | EXISTS (generic) | See above: hide the button instead. |
| Audit note shown | EXISTS | `:270`. Previous correction reason shown `:271`. |

### Reports (`instructor-reports.js`)
| Item | Status | Where / note |
|---|---|---|
| Date range (from / to / whole term) | EXISTS | `:41-56`, kept in the URL (`:86`). |
| Bad range handling | **BROKEN** | `:98-101`: on `fields.to` it shows a toast and `return`s. On **first load** (URL `?from=2026-12-01&to=2026-01-01`) the body stays a **skeleton forever** and the class picker stays "Loading…" (seen live). Show the message under the To input and render the class list anyway. `fields.from` is not handled at all. |
| CSV export | EXISTS | `:237-257` → shared `downloadCsv` / `csvText` (`attendance-ui.js:104-111`) escapes cells starting with `= + - @` and adds a BOM. Same helper the admin Attendance page uses ✅. No unit test for `csvText`. |
| Print | EXISTS | `:125` + `d-print-none`. |
| "Sessions held" hint | **BROKEN (wording)** | `:163` says "Completed class sessions", but `sessions` also contains a session in progress (and an early-tap upcoming one). Say "Sessions so far" or count `phase === 'ended'`. |
| Matrix legend | KEEP / minor | `:209` lists P/L/A only; the `·` (not yet) and `–` (joined later) marks have tooltips but no legend. |

### My Account
| Item | Status | Note |
|---|---|---|
| Account page (role instructor) | **MISSING** | `pages/account.js` is already role-generic (`document.body.dataset.role`). Needs `instructor/account.html` = copy of `admin/account.html` with `<body data-role="instructor">` + a nav item in `ui.js` `NAVIGATION.instructor`. |

### Session expiry
| Item | Status | Note |
|---|---|---|
| Expired / revoked token → login | EXISTS | `api.js:34-44` + `session.js` `expires_at` check. Seen live. Remove the 3 dead per-page checks. |

---

## 3. Unnecessary / leftovers

| Where | What | Recommend |
|---|---|---|
| `instructor-dashboard.js:51-54`, `instructor-attendance.js:96`, `instructor-reports.js:97` | `if (error.code === 'NOT_SIGNED_IN') … requireRole(...)`: `api.js` already redirected. | DELETE. |
| `components/attendance-ui.js:12-19` `SESSION_STATUS` (`closed`, `open`) | Status-based labels; `closed` never comes from a real session, `open` is wrong after the end. | REPLACE with a shared `SESSION_PHASE` + `phaseBadge(row)`: move them from `admin-dashboard.js:9-21` into `attendance-ui.js` so admin and instructor use one map. |
| `instructor-attendance.js:90` | `row.status === 'closed'` label logic. | REPLACE (phase). |
| `instructor-attendance.js:268` | `maxlength="200"`. | CHANGE to 500. |
| `instructor-attendance.js:197` | `countsBarHtml(info).replace('class="att-bar"', …)` string patch. | KEEP (works; optional `wide` param later). |
| `instructor-reports.js:16` | `null` key in `MARK` for the backend's `null` mark. | KEEP (correct, commented). |
| `frontend/README.md:78` | Documents `status` values for sessions, no `phase` / `not_scanned`. | UPDATE after Batch 1. |
| Google / demo / late-grace / default password wording | None in instructor pages or `attendance-ui.js`. `late` still exists as a correctable status (correct). | — |

---

## 4. Security

| Check | Result |
|---|---|
| Other instructors' classes from the UI | ✅ Pickers are filled only from the server's own-class list (`myClasses`). Hand-typed `?class=` of another instructor → `FORBIDDEN` "This class is not assigned to you." **Live:** `listSessions`, `getClassReport`, `getClassRoster`, `getRecentActivity` all `FORBIDDEN`. `getSession`, `getStudentHistory`, `correctAttendance` go through the same `ownClass()` (`portal.js:190-196`), covered by `portal.test.js`. Identity comes from `linked_id` on the session, never the request. |
| `escapeHtml` | ✅ Every server string is escaped (names, labels, room codes, reasons incl. the `title=` attribute at `instructor-attendance.js:228`). `formatClockTime` output is digits + AM/PM only (`Number()` parse), and counts are server numbers, so no gap found. |
| Secrets | ✅ None. Only `API_URL`. Token in `sessionStorage` + POST body; URL params are `class`, `session`, `from`, `to` only. |
| CSV injection | ✅ Shared `csvText` escapes `= + - @`. (Strict extra: leading tab / CR; optional.) |
| Role check | ✅ `requireRole('instructor')` on every page = navigation only; server enforces the role. |

---

## 5. Fix plan

Ordered. Effort: **S** < 1 h · **M** half a day · **L** about a day. Frontend only unless stated.

| # | Task | Functions / files | Effort |
|---|---|---|---|
| **Batch 1: phase + not yet (correctness)**: DONE 2026-11-20 (+ IFIX-11 csvText test, + past classes) | | | |
| IFIX-01 ✅ | Move `SESSION_PHASE` + `phaseBadge(row)` from `admin-dashboard.js` into `attendance-ui.js`; admin dashboard imports it; drop `SESSION_STATUS` `closed`/`open`. | `attendance-ui.js`, `admin-dashboard.js` | S |
| IFIX-02 ✅ | Dashboard: `phaseBadge(row)` in `sessionsHtml`; add "N not yet" to the counts. | `instructor-dashboard.js` `sessionsHtml` | S |
| IFIX-03 ✅ | Attendance: session option label from `phase` + counts; header `phaseBadge(info)`; filters **Present / Late / Absent / Not yet** (Not yet only while `upcoming`/`in_progress`); add a Not yet tile; hide Correct on `upcoming`; reason `maxlength` 500. | `instructor-attendance.js` `loadSessions`, `rosterHtml`, `rowsHtml`, `correctFlow` | S |
| IFIX-04 ✅ | Reports: "Sessions held" hint wording; legend adds `·` not yet and `–` joined later. Delete the 3 dead `NOT_SIGNED_IN` checks. | `instructor-reports.js` `reportHtml`, all 3 pages | S |
| **Batch 2: missing pieces**: DONE 2026-11-20 (past classes were done in Batch 1, IFIX-P) | | | |
| IFIX-05 ✅ | My Account: `instructor/account.html` (`data-role="instructor"`) + nav item `{ section: 'Account', … 'instructor/account.html' }`. | new HTML, `ui.js` `NAVIGATION.instructor` | S |
| IFIX-06 ✅ | Dashboard "Recent activity" card: `instructor.getRecentActivity {limit: 10}` (own fetch, own error state so the dashboard still loads if it fails); time, student, class, status badge, offline/corrected tags. | `instructor-dashboard.js` (new `recentHtml`) | S |
| **Batch 3: date filters** | | | |
| IFIX-07 | Attendance page: From/To inputs (URL params) → `listSessions {class_id, from, to}`; show `range`. | `instructor-attendance.js` `start`, `loadSessions` | M |
| IFIX-08 | Roster + student history panel: accept `{from, to}` and pass them (Reports and Attendance pass their current range); show the range in the panel. | `instructor-history.js` `openClassRoster`, `openStudentHistory` | S |
| IFIX-09 | Reports date errors: show `fields.from` / `fields.to` under the inputs (`is-invalid`), still fill the class picker, never leave the skeleton. | `instructor-reports.js` `load` | S |
| **Batch 4: robustness + polish** | | | |
| IFIX-10 | `FORBIDDEN` / `NOT_FOUND` deep link: clear `state.classId` and reload the own-class list with a warning toast instead of a "Try again" loop. Same in Reports. | `instructor-attendance.js` `loadSessions`, `instructor-reports.js` `load` | S |
| IFIX-11 ✅ | Tiny `node:test` for `csvText` (formula prefix, quotes, BOM). | `backend/tests` or `frontend` test file | S |
| IFIX-12 | Update `frontend/README.md` session fields (`phase`, `not_scanned`). | docs | S |
| IFIX-P ✅ | **Decided: yes, read-only.** Backend: `past_classes` (own inactive classes: `class_id, class_label, term_name`) on `instructor.getDashboard`, `listSessions`, `getClassReport`; every class object carries `status` (`past-classes.test.js`). Frontend: "Past / inactive classes (read-only)" `<optgroup>` in the Attendance and Reports pickers, a read-only card on the dashboard, banner + no Correct button on Attendance (`canCorrect`). `CLASS_INACTIVE` stays on the server. Done in Batch 1. | `portal.js` `pastClasses`, `classInfo`; `attendance-ui.js` `classOptionsHtml`, `canCorrect` | M |

Not done in this audit: no correction was submitted live (read-only audit; correction paths were checked in code + backend tests); the dashboard on a day with real (`open`) sessions was not seen live, because TEST data has no session today and seeded sessions are `closed`. The `phase` bugs above come from code reading.
