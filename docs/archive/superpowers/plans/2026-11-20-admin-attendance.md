# Admin Attendance List + Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two read-only admin actions: `admin.listAttendance` (filtered, paged rows) and `admin.getAttendanceReport` (per class / section / student totals + device queue info).

**Architecture:** New file `backend/src/handlers/attendance.js`. It imports the counting helpers that already exist in `portal.js` (exported, not copied) and the device summary from `dashboard.js` (moved out into one exported function). Tabs declared in `actions.js`, `mode: READ` (no lock).

**Tech Stack:** Node ES modules, `node:test`, Apps Script bundle (ES2020).

**Spec:** user request (2026-11-20) + `docs/PROJECT_CONTEXT.md` §8 Admin ("View all attendance records", "Generate reports"), §9 ("Attendance management", "Reports"), §13 ("Clearly distinguish pending offline records").

## Global Constraints

- Admin only (`role: 'admin'`), `mode: READ`, every tab declared (`tabs.test.js`).
- Dates: shared `dateRange(request)` (same errors: `VALIDATION_ERROR` on `fields.from` / `fields.to`); response echoes `range: {from, to}`.
- Effective status = `effectiveStatus(row)` (override wins). No record → `missingStatus`: `not_scanned` until the session ends, `absent` after.
- Never return `password_hash`, device keys, or `device_key_hash`.
- No CSV on the backend. (Frontend note for later: escape cells starting with `= + - @`.)
- Bundle stays ES2020; run build + `node --test` + `node --check`.

## Decisions I made (say no to any of these)

1. **`section_id` filter = the class's section** (`Classes.section_id`), in both actions. `group_by: 'section'` groups classes by their section. (Alternative: the student's own section; matters only for cross-section enrollees.)
2. **`group_by: 'student'`**: `enrolled` = number of the student's classes in scope; `sessions_held` = held sessions across those classes.
3. **Report classes** = active classes **plus** any other class with a counted session in the range (archived classes with history still show).
4. **Paging**: `page` default 1, `page_size` default 100; `page_size > 500` is **clamped** to 500 (not an error); non-integer or < 1 → `VALIDATION_ERROR` (`fields.page` / `fields.page_size`). Page past the end → `rows: []`, `total` unchanged.
5a. **Approved change:** `sessionCounts()` is FIXED (not worked around): an explicit override to absent counts as absent at once in every view; not_scanned only for enrolled students with no row. The admin dashboard uses `sessionCounts()` too (also fixes BUG-4). A test checks that getSession, both dashboards, instructor report, student overview and admin report agree.
5. **`status`** filter ∈ `present | late | absent` (records only — "not scanned" has no row); else `VALIDATION_ERROR fields.status`. Bad `group_by` → `VALIDATION_ERROR fields.group_by`.
6. **Speed**: `recordOf()` in portal.js does a linear `find` over all Attendance per (session, student). Admin report over all classes × 5,000 rows would be millions of comparisons in Apps Script. Fix once in the shared helper: index Attendance by `session_id:student_id` (cached per array, rebuilt if its length changes). Every portal action gets faster, results identical.
   - Smaller option: skip the index, keep linear scans (fine on the seeded Sheet, slow at 5,000).
7. Row measurement = a scratch script (not committed), modeled on `tools/measure_device_api.mjs`.
   - Bigger option: commit it as `tools/measure_admin_reports.mjs`.

## Review Focus

1. Override to `absent` on a session that has not ended yet → counts as **absent**, not not_scanned (the instructor report does this; `sessionCounts()` would not — so the report must use the `statusOf`/`summarize` path, not `sessionCounts`).
2. Manual rows (`source: 'manual'`, no device fields) list with `source: 'manual'`, empty `sync_mode` / `time_quality`.
3. Attendance row whose session or student was deleted/missing → row still listed with empty labels, no crash.
4. Cancelled sessions: their rows never count in the report; listAttendance still lists any row it has.
5. A dropped enrollment: instructor report ignores that student; admin report must too (same `rosterIds`).

---

### Task 1: Shared helpers (export + index), device summary

**Files:**
- Modify: `backend/src/handlers/portal.js` (export `lookups`, `sectionLabel`, `rosterIds`, `countedSessions`, `heldCount`, `statusOf`, `summarize`; index inside `recordOf`)
- Modify: `backend/src/handlers/dashboard.js` (move the `devices` map into `export function deviceSummaries(db, ctx)`; `getAdminDashboard` calls it)

**Interfaces — Produces:**
- `deviceSummaries(db, ctx) -> [{device_id, device_name, room_code, status, battery_voltage, low_battery, last_seen_at, online, queue_count}]` (non-retired; exactly today's dashboard shape)
- portal exports above, unchanged signatures.

- [ ] Step 1: Run `node --test` → all pass (baseline).
- [ ] Step 2: Make the edits. Index: `WeakMap<AttendanceArray, {length, map}>`; rebuild when `length` differs (correctAttendance pushes a row).
- [ ] Step 3: `node --test` → all pass, dashboard/portal tests unchanged.

### Task 2: `admin.listAttendance`

**Files:** Create `backend/src/handlers/attendance.js`; modify `backend/src/actions.js`; test `backend/tests/admin-attendance.test.js`.

**Signature:** `listAttendance(db, request, session, ctx) -> { range, page, page_size, total, rows }`

Row: `{ attendance_id, session_id, session_date, class_id, class_label, room_code, student_id, student_number, student_name, scanned_at, status (effective), device_status (row.status), source, sync_mode, time_quality, corrected: Boolean(override_status), override_by, override_by_name (Users display_name || username), override_at, override_reason }`

Filters on: `range.has(session.session_date)`, `class_id`, `section_id` (class's), `student_id`, `status` (effective). Sort: `scanned_at` desc, then `attendance_id` desc.

Tabs: `reads: 'Attendance ClassSessions Classes Rooms Students'` (Users comes with AUTH_TABS).

- [ ] Step 1: Failing tests:
  - `instructor` / `student` session via `runAction` → `FORBIDDEN`.
  - no filters → 3 rows, `total` 3, newest first.
  - each filter: `class_id: 'CLS-0002'` → only ATT-00003; `section_id: 'SEC-0001'` → ATT-00001/2; `student_id: 'STU-0002'` → ATT-00002; date range excluding 2026-11-17 → no ATT-00003.
  - override ATT-00001 to `absent`: `status: 'absent'` returns it with `status 'absent'`, `device_status 'present'`, `corrected true`, override fields filled; `status: 'present'` no longer returns it.
  - pad to 250 rows: `page_size 100, page 3` → 50 rows, `total 250`; `page_size 9999` → `page_size 500`; `page 0` / `page_size 'x'` → `VALIDATION_ERROR` on that field; `status: 'gone'` → `fields.status`.
  - `from: '2026-02-30'` → `fields.from`.
- [ ] Step 2: `node --test backend/tests/admin-attendance.test.js` → FAIL (not defined).
- [ ] Step 3: Implement; add action entry.
- [ ] Step 4: Tests + `tabs.test.js` pass.

### Task 3: `admin.getAttendanceReport`

**Signature:** `getAttendanceReport(db, request, session, ctx) -> { range, group_by, generated_at, groups, totals, devices, pending_offline_scans }`

Group: `{ key, label, sessions_held, enrolled, present, late, absent, not_scanned, total, rate }` — `class`: key class_id / label class_label; `section`: key section_id / label `sectionLabel`; `student`: key student_id / label "number name" (e.g. `2024000001 Carla Santos`). Sorted by label.

Math, per class in scope: `roster = rosterIds`, `sessions = countedSessions(...).filter(range)`, marks = `statusOf(recordOf(...), s, now)` for each session × roster student; `not_scanned` = count of `'not_scanned'` marks; the rest through `summarize`. `sessions_held = heldCount(sessions, now)`. Groups add class results (student group: add that student's marks). `totals` = same over all groups. `devices` = `deviceSummaries(db, ctx)` reduced to `{device_id, device_name, room_code, status, queue_count, last_seen_at, online}`; `pending_offline_scans` = sum of `queue_count`.

Tabs: `reads: \`${PORTAL} Devices Settings\`` (Settings: offline-after minutes, low battery).

- [ ] Step 1: Failing tests (same file):
  - non-admin → `FORBIDDEN`.
  - `group_by: 'class', class_id: 'CLS-0001'` + range → group numbers equal `portal.instructorClassReport(... instructorAna)` `totals` (present, late, absent, total, rate) for the same range; `sessions_held` equals its session count.
  - override STU-0001's record to `absent` → `absent` +1, `present` −1.
  - clock inside an open session (`2026-11-23T08:30` with a new open SES on that date, nobody scanned) → `not_scanned` = 3, `absent` 0; after `10:00` → `absent` 3.
  - `group_by: 'section'` → two groups SEC-0001 / SEC-0002 with `BSCpE 3A`/`3B` labels; `section_id` filter → one group.
  - `group_by: 'student'` → 4 groups, STU-0003 `absent 1`.
  - devices: one Devices row with `queue_count '4'` → `devices[0].queue_count 4`, `pending_offline_scans 4`.
  - `group_by: 'room'` → `fields.group_by`; `from > to` → `fields.to`.
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement + action entry.
- [ ] Step 4: All tests pass.

### Task 4: Verify, measure, document, commit

- [ ] `node tools/build_apps_script.mjs`; `node --check` on changed files; `npm test` → all pass.
- [ ] Scratch script: fake Apps Script, seeded and padded to 5,000 Attendance rows; log tabs read, rows read, rows written (must be 0), batchUpdates (0), ms for both actions.
- [ ] CLAUDE.md: short "Admin attendance" section (actions, the decisions above).
- [ ] Branch `admin-attendance`; commit (no deploy).
