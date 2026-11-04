# Frontend — RFID Attendance

Static web app (HTML, CSS, JavaScript, Bootstrap 5.3) for GitHub Pages.

## Status

| Part | Status |
|---|---|
| Design system (PSU maroon/gold), app shell, responsive sidebar | Done |
| Login page (demo sign-in only) | Done — Google Sign-In comes with the backend (Phase 1) |
| Admin dashboard | Done, **demo data only** |
| Admin: Students & RFID cards (add, edit, activate/deactivate, assign/replace/revoke card) | Done, **demo data only** |
| Admin: Academic setup (terms, programs, sections, subjects, rooms) | Done, **demo data only** |
| Admin: Instructors | Done, **demo data only** |
| Other admin pages, Instructor portal, Student portal | Not started |

## Run it locally

ES modules do not load from `file://`, so serve the folder:

- **VS Code:** install the "Live Server" extension, right-click `frontend/index.html` → *Open with Live Server* (port 5500), or
- **Terminal:** `cd frontend` then `python -m http.server 5500`, and open `http://localhost:5500`.

An internet connection is needed because Bootstrap and Bootstrap Icons load from the jsDelivr CDN.

## Demo mode vs live mode

Set in `assets/js/config.js`:

| `MODE` | What happens |
|---|---|
| `demo` (current) | Every API call is answered by `assets/js/demo/demo-api.js` using the **fake** test data. A "Demo mode" banner is always visible. Changes are kept in this browser tab only (sessionStorage) and disappear when the tab closes. "Reset demo data" in the user menu restores the original data. |
| `live` | Calls go to `API_URL` (the Apps Script Web App). Not usable until the backend exists. |

Pages never read the demo data directly. They only call `callApi(action, payload)` in `assets/js/api.js`, so switching to the real backend does not require changing any page.

## Folder structure

```
frontend/
├── index.html                 Login
├── admin/index.html           Admin dashboard
└── assets/
    ├── css/app.css            Design tokens + components
    └── js/
        ├── config.js          MODE, API_URL, GOOGLE_CLIENT_ID (public), timezone
        ├── api.js             callApi(): demo or live transport, error handling
        ├── session.js         Session storage (sessionStorage)
        ├── auth.js            Sign-in/out, role guard, URLs
        ├── ui.js              App shell, formatters, states, toasts, form/confirm dialogs
        ├── components/        Reusable widgets (resource-manager.js: list + search + form + status)
        ├── pages/             One script per page
        └── demo/
            ├── demo-api.js    Router: role checks, write rollback, saving
            ├── demo-store.js  Tab-scoped copy of the demo data
            ├── demo-utils.js  Shared helpers (dates, validation errors, audit log)
            ├── handlers/      One file per feature (dashboard, students)
            └── demo-data.js   GENERATED from RFID_Test_Data.xlsx — do not edit
```

To regenerate demo data after editing the workbook:

```
python tools/xlsx_to_demo_data.py path/to/RFID_Test_Data.xlsx
```

## API actions used so far

The Apps Script backend must implement these with the **same request and response shapes**.

### `auth.demoSignIn` (demo only)
Will be replaced by `auth.google` in Phase 1.

### `auth.logout`
Request: `{ session_token }` → `data: {}`

### `admin.getDashboard` (admin only)
Request: `{ session_token, date: "YYYY-MM-DD" }`

Response `data`:

| Field | Description |
|---|---|
| `date`, `today`, `in_term`, `term_name` | Context for the chosen date (Asia/Manila) |
| `stats` | `active_students`, `active_instructors`, `active_classes`, `sessions_on_date`, `students_present`, `attendance_rate` (0–1 or `null`), `devices_online`, `devices_total` |
| `sessions[]` | `class_label`, `subject_title`, `room_code`, `instructor_name`, `start_time`, `end_time`, `source` (`auto`/`manual`), `status` (`closed`/`open`/`cancelled`/`scheduled`/`in_progress`/`no_record`), `enrolled`, `present`, `late`, `absent` (counts are `null` unless the session is open or closed) |
| `devices[]` | `device_id`, `device_name`, `room_code`, `battery_voltage`, `low_battery`, `last_seen_at`, `online`, `queue_count` |
| `recent_scans[]` | Latest 10 ScanLog rows for the date: `scanned_at`, `student_name` (`null` if unknown card), `rfid_uid`, `room_code`, `result`, `sync_mode` |
| `alerts[]` | `level` (`danger`/`warning`/`info`), `icon`, `message`, optional `details[]` |

Errors: `NOT_SIGNED_IN`, `FORBIDDEN`, `BAD_REQUEST`.

### Students & RFID cards (admin only)

Every write is recorded in AuditLog. Card changes increment the `roster_version` setting so devices download the new roster.

| Action | Request (besides `session_token`) | Response `data` |
|---|---|---|
| `admin.getStudentOptions` | — | `sections[]` (`section_id`, `label`, `year_level`) |
| `admin.listStudents` | `search`, `section_id`, `status` (`active`/`inactive`/`all`), `card` (`all`/`with`/`without`), `page`, `page_size` (max 100) | `items[]`, `total`, `page`, `page_size`, `counts` (`active`, `inactive`, `without_card`) |
| `admin.getStudent` | `student_id` | `student`, `account` (`email`, `account_status`, `google_linked`, `last_login_at`), `cards[]` (history), `enrollments[]`, `attendance` summary |
| `admin.createStudent` | `student_number`, `first_name`, `last_name`, `section_id`, `email` | `student_id`. Also creates the student's Users row (role `student`) |
| `admin.updateStudent` | `student_id` + the same fields | `student_id`, `google_unlinked` (true if the email changed on a linked account) |
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
| Instructor | `admin.listInstructors`, `createInstructor`, `updateInstructor`, `setInstructorStatus` | `first_name`, `last_name`, `email`, `department` | Creates the Users row (role `instructor`); email unique across users; email change unlinks Google; cannot deactivate with active classes |

Blocked deactivations return `code: "IN_USE"` with a message listing what still depends on the record.

Validation rules: student number exactly 10 digits (assumption based on the current PSU format — confirm); names up to 60 letters; email unique across all users; UID normalized to uppercase hex without separators and must be 8, 14, or 20 characters (4-, 7-, or 10-byte UIDs); a UID active for another student, or with history under another student, is refused.

## Known limitations

- Frontend role checks are for navigation only. Real access control will be enforced by the backend.
- Demo "online" status uses the device `last_seen_at` in the test data, so all devices currently show **offline**. That is the correct result for that data.
- Bootstrap is loaded without Subresource Integrity hashes yet; add them before production.
