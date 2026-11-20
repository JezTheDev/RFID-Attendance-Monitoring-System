# Frontend — RFID Attendance

Static web app (HTML, CSS, JavaScript, Bootstrap 5.3) for GitHub Pages.
It always talks to the **live** Apps Script backend — there is no demo mode.

## Status

| Part | Status |
|---|---|
| Design system (PSU maroon/gold), app shell, responsive sidebar | Done |
| Admin portal: dashboard, attendance, students & RFID cards, instructors, admins, classes, academic setup, devices, settings, my account | Done |
| Instructor portal: dashboard (+ recent activity, past classes), attendance (sessions + corrections + date filter), reports + CSV, my account | Done |
| Student portal: overview, history, profile | Done |
| Login page | Username / student number + password (`auth.login`), forced change-password step (`auth.changePassword`). Polish comes in Step 3. |

## Run it locally

ES modules do not load from `file://`, so serve the folder:

- **VS Code:** "Live Server" extension → right-click `frontend/index.html` → *Open with Live Server* (port 5500), or
- **Terminal:** `cd frontend` then `python -m http.server 5500`, and open `http://localhost:5500`.

An internet connection is needed (Bootstrap from the jsDelivr CDN, and the Apps Script backend).

## Configuration

`assets/js/config.js`:

| Key | Meaning |
|---|---|
| `API_URL` | Apps Script Web App URL (ends in `/exec`). Every page calls it. |
| `TIMEZONE` | `Asia/Manila`, for showing dates and times |

Pages never talk to the Sheet. They only call `callApi(action, payload)` in
`assets/js/api.js`, which POSTs `text/plain` JSON to `API_URL` (no CORS preflight).
**Access control is on the server**; role checks in the browser only decide which page to show.

## Folder structure

```
frontend/
├── index.html                 Login
├── admin/                     index, attendance, students, instructors, admins, classes, academic, devices, settings, account
├── instructor/                index, attendance, reports, account
├── student/                   index, history, profile
└── assets/
    ├── css/                   app.css (design tokens + components), auth.css, bubbles.css
    └── js/
        ├── config.js          API_URL, timezone
        ├── api.js             callApi(): sends requests to the backend, error handling
        ├── session.js         Session storage (sessionStorage)
        ├── auth.js            Sign-in/out, role guard, URLs
        ├── ui.js              App shell, formatters, states, toasts, form/confirm dialogs
        ├── auth-forms.js      Login page forms and animations
        ├── components/        resource-manager.js (list + search + form + status), attendance-ui.js
        └── pages/             One script per page
```

The business logic behind every action lives in `backend/src/` (see `backend/README.md`).

## API actions (reference)

The full list is in `backend/src/actions.js`. Sign-in actions (`auth.login`, `auth.me`,
`auth.changePassword`, `auth.logout`, `admin.resetPassword`, `admin.unlockUser`) are
described in `backend/README.md` → *Sign-in (auth API)*. Account fields in admin responses:
`username`, `must_change_password`, `locked`, `last_login_at` (never a password or hash).

### `admin.getDashboard` (admin only)
Request: `{ session_token, date: "YYYY-MM-DD" }`

Response `data`:

| Field | Description |
|---|---|
| `date`, `today`, `in_term`, `term_name` | Context for the chosen date (Asia/Manila) |
| `stats` | `active_students`, `active_instructors`, `active_classes`, `sessions_on_date`, `students_present`, `attendance_rate` (0–1 or `null`), `devices_online`, `devices_total` |
| `sessions[]` | `class_label`, `subject_title`, `room_code`, `instructor_name`, `start_time`, `end_time`, `source` (`auto`/`manual`), `session_id` (`null` = no tap yet), `phase` (`upcoming`/`in_progress`/`ended`/`cancelled`; **use this for labels**: a real session keeps `status: open` after it ends), `enrolled`, `present`, `late`, `absent`, `not_scanned` (no tap yet, only before the end; counts are `null` without a session row) |
| `devices[]` | `device_id`, `device_name`, `room_code`, `battery_voltage`, `low_battery`, `last_seen_at`, `online`, `queue_count` |
| `recent_scans[]` | Latest 10 ScanLog rows for the date: `scanned_at`, `student_name` (`null` if unknown card), `rfid_uid`, `room_code`, `result`, `sync_mode` |
| `alerts[]` | `level` (`danger`/`warning`/`info`), `icon`, `message`, optional `details[]` |

Errors: `NOT_SIGNED_IN`, `FORBIDDEN`, `BAD_REQUEST`.

### Instructor portal (instructor only)

Identity comes from the session (`linked_id`); a class that is not the instructor's → `FORBIDDEN`.

| Action | Request | Notes |
|---|---|---|
| `instructor.getDashboard` | `date` | `stats`, `sessions[]` (same session fields as above, incl. `phase`, `not_scanned`), `classes[]` (active), `past_classes[]`, `watchlist[]` |
| `instructor.getRecentActivity` | `class_id?`, `limit?` (default 20, max 50) | `{limit, has_more, items[]}`: `student_name`, `class_label`, `session_id`, `scanned_at`, `status`, `source`, `sync_mode`, `corrected` |
| `instructor.listSessions` | `class_id?`, `from?`, `to?` | `classes[]`, `past_classes[]`, `class` (incl. `status`), `range`, `sessions[]` |
| `instructor.getSession` | `session_id` | `session`, `class` (incl. `status`), `students[]` (`status` incl. `not_scanned`, `corrected`, `correction_reason`) |
| `instructor.getClassRoster` / `getStudentHistory` | `class_id` (+ `student_id`), `from?`, `to?` | echo `range` |
| `instructor.getClassReport` | `class_id?`, `from?`, `to?` | `classes[]`, `past_classes[]`, `class`, `range`, `sessions[]`, `students[].marks` (`null` = joined later), `totals` |
| `instructor.correctAttendance` | `session_id`, `student_id`, `status`, `reason` (5–500) | `SESSION_NOT_STARTED`, `SESSION_CANCELLED`, `CLASS_INACTIVE` (past classes are read-only), `NOT_ENROLLED`; BUG-6 message in `fields.status` |

`past_classes[]` = the instructor's own inactive classes (`class_id`, `class_label`, `term_name`): readable, never correctable.
Dates: `YYYY-MM-DD`, inclusive; bad date / `from > to` / over 366 days → `VALIDATION_ERROR` in `fields.from` / `fields.to`.

### Students & RFID cards (admin only)

Every write is recorded in AuditLog. Card changes increment the `roster_version` setting so devices download the new roster.

| Action | Request (besides `session_token`) | Response `data` |
|---|---|---|
| `admin.getStudentOptions` | — | `sections[]` (`section_id`, `label`, `year_level`) |
| `admin.listStudents` | `search`, `section_id`, `status` (`active`/`inactive`/`all`), `card` (`all`/`with`/`without`), `page`, `page_size` (max 100) | `items[]`, `total`, `page`, `page_size`, `counts` (`active`, `inactive`, `without_card`) |
| `admin.getStudent` | `student_id` | `student`, `account` (`username`, `email`, `account_status`, `must_change_password`, `locked`, `last_login_at`), `cards[]` (history), `enrollments[]`, `attendance` summary |
| `admin.createStudent` | `student_number`, `first_name`, `last_name`, `section_id`, `email` (optional) | `student_id`, `classes_joined`, `temp_password` (shown once), `temp_password_expires_at`. Also creates the student's Users row (role `student`, username = student number, random temporary password, must change) |
| `admin.updateStudent` | `student_id` + the same fields | `student_id` (the username follows the student number) |
| `admin.setStudentStatus` | `student_id`, `status` (`active`/`inactive`), `reason` | `account_status`, `revoked_card_id`. Deactivation disables sign-in and revokes the active card |
| `admin.assignCard` | `student_id`, `rfid_uid`, `replace_reason` (`lost`/`damaged`/`other`, required when replacing), `note` | `card_id`, `replaced_card_id` |
| `admin.revokeCard` | `student_id`, `reason` | `card_id` |
| `admin.listUnregisteredUids` | — | `items[]` of unknown UIDs from ScanLog (`rfid_uid`, `scan_count`, `last_seen_at`, `room_code`) |

Validation errors return `code: "VALIDATION_ERROR"` with `fields: { field_name: "message" }`.

### Academic setup and instructors (admin only)

Each list action returns `{ items }` (all rows; the page filters and searches them). Create/update return the record ID. Status actions take `status: "active" | "inactive"`.

| Entity | Actions | Fields | Rules |
|---|---|---|---|
| Term | `admin.listTerms`, `createTerm`, `updateTerm`, `setActiveTerm` (`term_id`) | `term_name`, `start_date`, `end_date` | Name unique; end after start; terms cannot overlap; dates cannot exclude recorded sessions; exactly one active term |
| Program | `admin.listPrograms`, `createProgram`, `updateProgram`, `setProgramStatus` | `program_code`, `program_name` | Code unique; cannot deactivate with active sections or students |
| Section | `admin.listSections` (also returns `programs` options), `createSection`, `updateSection`, `setSectionStatus` | `program_id`, `year_level` (1–5), `section_name` (stored uppercase) | Name unique within program; program/year locked while active students belong to it; cannot deactivate with active students or classes |
| Subject | `admin.listSubjects`, `createSubject`, `updateSubject`, `setSubjectStatus` | `subject_code` (stored uppercase), `subject_title`, `units` (1–10) | Code unique; cannot deactivate while used by active classes |
| Room | `admin.listRooms`, `createRoom`, `updateRoom`, `setRoomStatus` | `room_code` (uppercase, no spaces), `room_name`, `building` (optional) | Code unique; cannot deactivate with active schedules or an assigned device |
| Instructor | `admin.listInstructors`, `createInstructor`, `updateInstructor`, `setInstructorStatus` | `username`, `first_name`, `last_name`, `email` (optional), `department` | Creates the Users row (role `instructor`, random temporary password returned once as `temp_password`, must change); username unique across users; cannot deactivate with active classes |

Blocked deactivations return `code: "IN_USE"` with a message listing what still depends on the record.

Validation rules: student number exactly 10 digits (assumption based on the current PSU format — confirm); names up to 60 letters; email optional, unique across all users when given; student number must not be used as another account's username; UID normalized to uppercase hex without separators and must be 8, 14, or 20 characters (4-, 7-, or 10-byte UIDs); a UID active for another student, or with history under another student, is refused.

## Known limitations

- Frontend role checks are for navigation only. Access control is enforced by the backend.
- With the fake seed data, all devices show **offline** (their `last_seen_at` is old). That is the correct result for that data.
- Bootstrap is loaded without Subresource Integrity hashes yet; add them before production.
