# System Logic Reference (for the thesis / paper)

Source of truth: the code in this repo as of 2026-11-25 (`main` @ 1d30de6, plus the
uncommitted `firmware/` folder). Every rule below was read from code; doc-only claims
are marked **(doc)**. Where docs and code disagree, the code wins (see §8).
Secrets (pepper, keys, passwords, `API_URL`) are not reproduced here.

Legend: `file:function`. "Manila" = Asia/Manila, UTC+08:00, no daylight saving.

---

## 1. Google Sheets data layer

### 1.1 Tabs and columns (`backend/src/schema.js:TAB_COLUMNS`)

| Tab | Columns (in Sheet order) |
|---|---|
| Terms | term_id, term_name, start_date, end_date, is_active |
| Programs | program_id, program_code, program_name, status |
| Sections | section_id, program_id, year_level, section_name, status |
| Subjects | subject_id, subject_code, subject_title, units, status |
| Rooms | room_id, room_code, room_name, building, status |
| Instructors | instructor_id, first_name, last_name, email, department, account_status |
| Students | student_id, student_number, first_name, last_name, program_id, year_level, section_id, email, account_status |
| Users (`auth/admin-users.js:USER_COLUMNS`) | user_id, username, email, role, linked_id, account_status, password_hash, must_change_password, failed_attempts, locked_until, password_changed_at, created_by, last_login_at, created_at, updated_at, display_name, temp_password_expires_at |
| RfidCards | card_id, rfid_uid, student_id, status, assigned_at, revoked_at, notes |
| Devices (`handlers/devices.js:DEVICE_COLUMNS`) | device_id, room_id, device_name, device_key_hash, status, firmware_version, battery_voltage, wifi_rssi, queue_count, time_synced, last_seen_at, last_heartbeat_at, notes |
| Classes | class_id, term_id, subject_id, section_id, instructor_id, class_label, status |
| Schedules | schedule_id, class_id, room_id, day_of_week, start_time, end_time, status |
| Enrollments | enrollment_id, class_id, student_id, status, enrolled_at |
| ClassSessions | session_id, class_id, room_id, schedule_id, session_date, scheduled_start, scheduled_end, actual_start, actual_end, source, status, opened_by, closed_by, override_reason, created_at |
| Attendance | attendance_id, session_id, student_id, card_id, rfid_uid, device_id, scan_id, scanned_at, received_at, status, source, sync_mode, time_quality, created_by, override_status, override_by, override_at, override_reason |
| ScanLog | log_id, scan_id, device_id, rfid_uid, scanned_at, received_at, result, session_id, student_id, attendance_id, sync_mode |
| AuditLog | audit_id, timestamp, user_id, role, action, entity_type, entity_id, before_json, after_json, reason |
| AuthSessions | token_hash, user_id, created_at, expires_at, revoked |
| Settings | key, value, description, source |

19 data tabs. Enumerated values used by the code:

| Field | Values |
|---|---|
| Users.role | admin, instructor, student |
| Users.account_status | active, disabled |
| Students/Instructors.account_status | active, inactive |
| Programs/Sections/Subjects/Rooms/Classes/Schedules.status | active, inactive |
| Terms.is_active | TRUE / FALSE (one TRUE at a time, `academic.js:setActiveTerm`) |
| RfidCards.status | active, revoked, lost |
| Devices.status | active, maintenance, retired |
| Enrollments.status | enrolled, dropped |
| ClassSessions.source / status | auto, manual / open, closed, cancelled |
| Attendance.status (device) | present (a tap is always present) |
| Attendance.override_status | present, late, absent, or '' |
| Attendance.source | device, manual |
| Attendance/ScanLog.sync_mode | live, offline ('' for manual rows) |
| Attendance.time_quality | ntp, backfilled, unverified ('' for manual) |
| ScanLog.result | ACCEPTED, DUPLICATE, NOT_ENROLLED, NO_ACTIVE_SESSION, SESSION_CANCELLED, UNREGISTERED, INVALID_TIME |

### 1.2 "View - …" tabs (`Server.gs:setupViews`, `buildView_`)

Read-only formula tabs for people; the server skips any tab whose name starts with
`View - ` (`isViewTab_`).

| View | Formula logic | Columns |
|---|---|---|
| View - Scans | `ARRAYFORMULA(SORT(FILTER({…}, ScanLog.scanned_at<>"")), 1 desc, 2 desc)` | Date, Time, Card UID, Student ("(unknown card)" if no student_id), Room, Class, Result |
| View - Attendance | same pattern over Attendance; `Status = PROPER(IF(override_status<>"", override_status, status))` | Date, Time in, Student no., Student, Class, Room, Status, Recorded by (`source="device"` → "RFID tap", else "Instructor correction") |

Names are resolved with `IFERROR(VLOOKUP(id, tab!A2:…, col, FALSE), "")`.

### 1.3 DEFAULT_SETTINGS (`schema.js:DEFAULT_SETTINGS` ← `handlers/settings.js:EDITABLE_SETTINGS`)

| key | default | min | max | decimal | used by |
|---|---|---|---|---|---|
| duplicate_window_minutes | 5 | 0 | 60 | no | `device.getRoster` (sent to device) |
| early_window_minutes | 15 | 0 | 60 | no | `sessions.js:resolveScan` |
| accept_after_end_minutes | 0 | 0 | 60 | no | `sessions.js:resolveScan` |
| low_battery_voltage | 3.5 | 3.00 | 4.20 | yes (≤2 dp) | heartbeat `low_battery`, dashboard |
| device_offline_after_minutes | 10 | 1 | 1440 | no | `dashboard.js:deviceSummaries` |
| heartbeat_interval_seconds | 300 | 30 | 3600 | no | `device.getRoster` (sent to device) |
| session_token_hours | 8 | 1 | 24 | no | `auth/session.js:startSession` |
| max_login_attempts | 5 | 3 | 20 | no | `auth/account.js:login` |
| lockout_minutes | 15 | 1 | 1440 | no | `auth/account.js:login` |
| temp_password_days | 7 | 1 | 30 | no | `auth/admin-users.js:issueTempPassword` |
| roster_version | 1 | — | — | system only, hidden | devices re-download roster on change |

Code fallbacks when a row is missing are the same numbers (e.g. `setting(db,'early_window_minutes')` → 15).

### 1.4 ID formats (`utils.js:nextId`)

`nextId(rows, key, prefix, width=4)` = `prefix-` + (highest numeric suffix among loaded rows + 1), zero-padded to `width` (wider numbers are not truncated).

| Prefix | Tab | Width | Prefix | Tab | Width |
|---|---|---|---|---|---|
| TRM | Terms | 4 | CLS | Classes | 4 |
| PRG | Programs | 4 | SCH | Schedules | 4 |
| SEC | Sections | 4 | ENR | Enrollments | 4 |
| SUB | Subjects | 4 | SES | ClassSessions | 4 |
| ROM | Rooms | 4 | AUD | AuditLog | 4 |
| INS | Instructors | 4 | ATT | Attendance | **5** |
| STU | Students | 4 | LOG | ScanLog | **5** |
| USR | Users | 4 | CRD | RfidCards | 4 |

Special IDs:
- `device_id` = `DEV-<room_code>-NN` (2-digit, highest for that prefix + 1, never reused because devices are never deleted; keeps the original room code after a room change) — `devices.js:createDevice`.
- `scan_id` = `<device_id>-<boot_count:6>-<sequence:6>`, regex for the suffix `^\d{6}-\d{6}$` — `device.js:validScans`, firmware `nextScanId`.
- Attendance correction audit entity id = `<session_id>:<student_id>`.

**Last-row rule (append tabs).** Tabs declared as `appends` load only the header and the
LAST sheet row (`Server.gs:readTabs_`), so `nextId` sees only that row → next id = last
id + 1. This requires rows to stay in id order (never sort raw tabs). If the last row's
id does not match `/^[A-Z]+-\d+$/` the tab is re-read fully (`readTabs_` refetch).
In the current action table **only AuditLog** is ever declared as `appends`; Attendance,
ScanLog, ClassSessions are loaded fully by the actions that write them.

### 1.5 Storage rules

| Rule | Where |
|---|---|
| Every cell is plain text: setup sets number format `@`; saves write `userEnteredValue.stringValue`; reads use `FORMATTED_VALUE` and `String()` | `Server.gs:setupSheets/setupEmptySheets`, `cellRow_`, `batchGet_`, `setTab_` |
| Booleans stored as `TRUE` / `FALSE` text | everywhere (`isTrue`) |
| Date `YYYY-MM-DD`; time `HH:mm` 24 h (`/^([01]\d|2[0-3]):[0-5]\d$/`) | `utils.js:isValidDate`, `classes.js:TIME_PATTERN` |
| Timestamp = Manila ISO `YYYY-MM-DDTHH:mm:ss+08:00` = `new Date(ms + 8h).toISOString().slice(0,19) + '+08:00'` | `utils.js:toManilaIso` |
| One clock per request: `ctx.now()` = `Date.now()` in Server.gs, fake in tests | `auth/context.js`, `Server.gs:nowMs_` |
| Day code from date via UTC weekday → SUN..SAT | `utils.js:dayCodeOf` |
| Free text cleaned (`trim`, collapse whitespace) and capped at `MAX_TEXT = 500` chars (Sheet cell limit is 50,000) | `utils.js:cleanText`, `MAX_TEXT` |
| Empty cell ↔ `''`; blank rows are skipped on read | `Server.gs:setTab_` |

### 1.6 Request pipeline (`Server.gs:doPost → handleRequest_`)

| # | Step | Detail |
|---|---|---|
| 1 | Parse | `JSON.parse(postData.contents)`; failure → `BAD_REQUEST` |
| 2 | Route | `device.*` → `RFID.deviceTabsFor`, write = has writes. Else `RFID.findAction`; unknown → `UNKNOWN_ACTION`; write = `mode === 'write'` |
| 3 | Lock (writes only) | `LockService.getScriptLock().tryLock(LOCK_WAIT_MS = 10000)`; failure → `SERVER_BUSY`. Reads never lock |
| 4 | Context | `authContext_()` reads all Script Properties once |
| 5 | Load | `loadDb_`: ONE `Sheets.Spreadsheets.Values.batchGet` for all declared ranges (full tabs + header/last row of append tabs) |
| 6 | Guard | `actions.js:guardDb`: rows of read-only and append tabs are frozen; replacing an undeclared tab throws; reading an undeclared tab lazy-loads it with a console warning (tests fail instead) |
| 7 | Run | `RFID.runAction` (user) or `RFID.runDeviceAction` (device) |
| 8 | Save (writes only) | `saveDb_`: diff each tracked tab against a JSON snapshot per row → per-row `updateCells` for edited rows, one `appendCells` for new rows, full body rewrite only if rows were removed (blanks the old tail); `appendDimension` first if the grid is too small; one `Sheets.Spreadsheets.get` for grid sizes, then **ONE `spreadsheets.batchUpdate`** (all-or-nothing per Google docs) |
| 9 | Reply | `{ok:true, server_time, data}` or `{ok:false, server_time, error:{code,message,fields?}}`; `server_time` = Manila ISO |
| 10 | Errors | Any throw → nothing saved, **except** `error.commit === true` (failed logins) → state still saved. AppError → its code; anything else → logged + `SERVER_ERROR` |
| 11 | Finally | lock released |

Tabs loaded per action (`actions.js:tabsFor`): `read` = AUTH_TABS (`AuthSessions Users`, for non-public actions) ∪ `reads` ∪ `writes`; `append` = `appends` not already read.
`doGet` returns `{ok:true, data:{service:'RFID Attendance API', status:'running'}}` (deployment check).

---

## 2. Backend logic

### 2.1 Action gate (`actions.js:runAction`)

1. Unknown name → `UNKNOWN_ACTION`.
2. `role: 'public'` → run with `session = null`.
3. `auth/session.js:authorize(token)` → `NOT_SIGNED_IN` if no token / unknown hash / revoked / `expires_at ≤ now` / user missing or not `active`.
4. Role mismatch (unless role `any`) → `FORBIDDEN`.
5. `must_change_password` TRUE and action ∉ {auth.me, auth.changePassword, auth.logout} → `PASSWORD_CHANGE_REQUIRED`.
6. `run(db, request, session, ctx)`.

Device gate (`actions.js:runDeviceAction`): `authenticateDevice` FIRST, then unknown `device.*` → `UNKNOWN_ACTION` (only `Devices` loaded).

### 2.2 Action table (`actions.js:ACTIONS`, `DEVICE_ACTIONS`)

R = read (no lock), W = write (lock + one batchUpdate). Tabs: r = reads, w = writes, a = appends. Signed-in actions also read `AuthSessions Users`.
`PORTAL` = Terms Programs Sections Subjects Rooms Instructors Students Classes Schedules Enrollments ClassSessions Attendance RfidCards. `CLASS_REF` = PORTAL minus ClassSessions, Attendance, RfidCards.

| Action | Role | Mode | Tabs |
|---|---|---|---|
| auth.login | public | W | r Users Settings AuthSessions Instructors Students; w Users AuthSessions; a AuditLog |
| auth.logout | public | W | r/w AuthSessions |
| auth.me | any | R | r Instructors Students |
| auth.changePassword | any | W | w Users AuthSessions; a AuditLog |
| admin.getDashboard | admin | R | r Attendance ClassSessions Classes Devices Enrollments Instructors RfidCards Rooms ScanLog Schedules Settings Students Subjects Terms |
| admin.listAttendance | admin | R | r Attendance ClassSessions Classes Rooms Students |
| admin.getAttendanceReport | admin | R | r Attendance ClassSessions Classes Devices Enrollments Instructors Programs Rooms Sections Settings Students Subjects |
| admin.correctAttendance | admin | W | r PORTAL; w Attendance; a AuditLog |
| admin.getStudentOptions | admin | R | r Programs Sections |
| admin.listStudents | admin | R | r Programs RfidCards Sections Students |
| admin.getStudent | admin | R | r Attendance Classes Enrollments Programs RfidCards Sections Students Subjects |
| admin.listUnregisteredUids | admin | R | r Devices RfidCards Rooms ScanLog |
| admin.createStudent | admin | W | r Classes Enrollments Programs Sections Settings Students Terms; w Students Users Enrollments; a AuditLog |
| admin.updateStudent | admin | W | same reads; w Students Users Settings Enrollments; a AuditLog |
| admin.setStudentStatus | admin | W | r RfidCards Settings Students; w Students Users RfidCards Settings AuthSessions; a AuditLog |
| admin.assignCard / revokeCard | admin | W | r RfidCards Settings Students; w RfidCards Settings; a AuditLog |
| admin.listTerms | admin | R | r Classes Terms |
| admin.createTerm / updateTerm | admin | W | r ClassSessions Classes Terms; w Terms; a AuditLog |
| admin.setActiveTerm | admin | W | r/w Terms; a AuditLog |
| admin.list/create/update/setStatus Program | admin | R/W | Programs (+ Sections Students for list/status) |
| admin.list/create/update/setStatus Section | admin | R/W | Sections (+ Programs Students Classes) |
| admin.list/create/update/setStatus Subject | admin | R/W | Subjects (+ Classes) |
| admin.list/create/update/setStatus Room | admin | R/W | Rooms (+ Devices Schedules Classes) |
| admin.listDevices | admin | R | r Devices Rooms |
| admin.createDevice | admin | W | r Rooms; w Devices; a AuditLog |
| admin.updateDevice / setDeviceStatus / generateDeviceKey | admin | W | w Devices; a AuditLog |
| admin.assignDeviceRoom | admin | W | r Rooms; w Devices; a AuditLog |
| admin.listInstructors | admin | R | r Classes Instructors |
| admin.createInstructor | admin | W | r Instructors Settings; w Instructors Users; a AuditLog |
| admin.updateInstructor | admin | W | r Instructors; w Instructors Users; a AuditLog |
| admin.setInstructorStatus | admin | W | r Classes Instructors; w Instructors Users AuthSessions; a AuditLog |
| admin.listAdmins | admin | R | (Users via AUTH_TABS) |
| admin.createAdmin | admin | W | r Settings; w Users; a AuditLog |
| admin.updateAdmin | admin | W | w Users; a AuditLog |
| admin.setAdminStatus | admin | W | w Users AuthSessions; a AuditLog |
| admin.resetPassword | admin | W | r Settings; w Users AuthSessions; a AuditLog |
| admin.unlockUser | admin | W | w Users; a AuditLog |
| admin.getSettings | admin | R | r Settings |
| admin.updateSettings | admin | W | w Settings; a AuditLog |
| admin.getClassOptions / listClasses / getClass | admin | R | r CLASS_REF |
| admin.createClass | admin | W | r CLASS_REF; w Classes Enrollments; a AuditLog |
| admin.updateClass / setClassStatus | admin | W | r CLASS_REF; w Classes; a AuditLog |
| admin.addSchedule / removeSchedule | admin | W | r CLASS_REF; w Schedules; a AuditLog |
| admin.enrollStudents / dropEnrollment | admin | W | r CLASS_REF; w Enrollments; a AuditLog |
| instructor.getDashboard / listSessions / getSession / getClassReport / getClassRoster / getStudentHistory | instructor | R | r PORTAL |
| instructor.correctAttendance | instructor | W | r PORTAL; w Attendance; a AuditLog |
| instructor.getRecentActivity | instructor | R | r Attendance ClassSessions Classes Students |
| student.getOverview / getHistory / getProfile | student | R | r PORTAL |
| device.submitScans | device key | W | r Terms Classes Schedules Enrollments RfidCards Students Settings; w Devices ClassSessions Attendance ScanLog |
| device.heartbeat | device key | W | r Settings; w Devices |
| device.getRoster | device key | R | r Devices RfidCards Students Settings |

Total: 76 user actions + 3 device actions. Every declared tab list is checked by `tests/tabs.test.js`.

### 2.3 Session engine (`backend/src/sessions.js`)

**sessionPhase(session, now)** — `now = {date, time}` in Manila, compared as strings `"YYYY-MM-DD HH:mm"`:

| Condition (in order) | Phase |
|---|---|
| status = cancelled | cancelled |
| status = closed | ended |
| now < date + start | upcoming |
| now ≤ date + end | in_progress |
| else | ended |

start = `actual_start || scheduled_start`, end = `actual_end || scheduled_end`. Sessions are never closed by a job or trigger; "ended" is computed from the clock.

**missingStatus(session, now)** = `absent` if phase is `ended`, else `not_scanned`.

**resolveScan(db, {room_id, scanned_at, student_id}, settings, nowMs)** — pure, no writes:

| # | Step | Result if it fails |
|---|---|---|
| 1 | `scanned_at` (epoch s) must be a finite number > 0 and ≤ `now/1000 + 300` (MAX_FUTURE_SECONDS = 5 min). Old scans are allowed | INVALID_TIME |
| 2 | Convert to Manila date + `HH:mm` (seconds dropped); t = minutes since midnight | — |
| 3 | Tap window per slot: `start − early_window_minutes ≤ t ≤ end + accept_after_end_minutes` (inclusive) | — |
| 4 | Active term: `is_active = TRUE` and `start_date ≤ date ≤ end_date` | NO_ACTIVE_SESSION |
| 5 | Candidates A: ClassSessions with `source = manual`, same room + date, not cancelled, window covers t. If any exist, they win | — |
| 6 | Else candidates B: Schedules `active`, same room, `day_of_week = dayCode(date)`, window covers t, class `active` and in the active term; each attached to the existing session for (`schedule_id`, `session_date`), if any | none → NO_ACTIVE_SESSION |
| 7 | Drop candidates whose session is cancelled | none left → SESSION_CANCELLED |
| 8 | Tie-breaker (back-to-back / overlapping windows): sort by key `[enrolled ? 0 : 1, has record in that session ? 1 : 0, start ≤ t ≤ end ? 0 : 1, start minutes]`, lexicographic, pick the first | — |
| 9 | Student must be `enrolled` in the chosen class | NOT_ENROLLED (+class_id) |
| 10 | Target session = existing one, or **lazy creation** of a new one: `SES-NNNN`, `source auto`, `status open`, scheduled times from the schedule, `actual_*` '', `created_at` = now | — |
| 11 | Student already has an Attendance row in that session | DUPLICATE |
| 12 | Else | ACCEPTED, `attendance_status: 'present'` |

Effect of the tie-breaker: when class A ends 10:00 and class B starts 10:00 in the same
room (B's early window overlaps A), a student enrolled in only one gets that one; a
student enrolled in both who already tapped A gets B; otherwise the class whose core time
contains t wins, then the earlier start.

The new session is saved only when the scan is ACCEPTED (`device.js:handleScan`), so at
most one ClassSession exists per (schedule_id, session_date).

### 2.4 Counting rules (`handlers/portal.js`, shared by all views)

| Helper | Rule |
|---|---|
| `utils.js:effectiveStatus(row)` | `override_status || status` |
| `rosterIds` | Enrollments `enrolled` for the class AND student `account_status = active` |
| `countedSessions` | ClassSessions of the class with status `open` or `closed` (cancelled never count), sorted by date, start |
| `heldCount` | counted sessions whose phase ≠ `upcoming` |
| `recordOf` | FIRST Attendance row for (session_id, student_id) (cached index, rebuilt when the row count changes) |
| `statusOf(record, session, now)` | record ? effectiveStatus : missingStatus |
| `statusFor(db, session, student, now)` | record → effectiveStatus; no record and `enrolled_at > "<session_date>T<end>:00+08:00"` → `null` (not counted); else missingStatus |
| `sessionCounts` | for open/closed sessions: count present / late / absent / not_scanned over the roster; `enrolled = roster − joined-later`; non-counted sessions return nulls |
| `summarize(statuses)` | counts present, late, absent; `total = present + late + absent` |

**Attendance rate (portals, reports)** — `portal.js:rate`:

```
rate = (present + late) / (present + late + absent)      if the denominator > 0
rate = null                                               otherwise
```
`not_scanned` (session still running) and `cancelled` are excluded from numerator and denominator.

**Admin dashboard rate** (`dashboard.js:getAdminDashboard`) uses a different formula:
```
attendance_rate = Σ(present + late) / Σ enrolled     over the date's counted sessions
```
Here `enrolled` includes students still `not_scanned`, so mid-class the dashboard rate
is lower than the portal rate (known, see §7).

Other derived numbers:
- Instructor watchlist (`instructorDashboard`): per class with ≥ 2 counted sessions, students with rate < 0.80; sorted by rate ascending, then absences descending; top 8.
- Instructor dashboard `stats.attendance_rate` = rate over the summed class totals.
- Student overview `recent` = 6 newest non-cancelled history rows.
- `late` is reachable only through a correction (the device always writes present).

### 2.5 Duplicate prevention (all layers)

| Layer | Mechanism | Where |
|---|---|---|
| 1. Device cooldown | Same UID within `duplicateWindowMs` (5 min, hard-coded) after an ACCEPTED/DUPLICATE reply → "Already scanned", not sent | firmware `loop`, `submitLiveScan` |
| 2. scan_id idempotency | ScanLog lookup by `scan_id` → `ALREADY_RECORDED` + `original_result`, **no new rows** | `device.js:handleScan` |
| 3. scan_id ownership | `scan_id` must start with the caller's `device_id-` → else `BAD_REQUEST` (no cross-device replay) | `device.js:validScans` |
| 4. One record per (session, student) | existing Attendance row → `DUPLICATE` (a ScanLog row is still written) | `sessions.js:resolveScan` |
| 5. One session per (schedule, date) | existing session reused; new one saved only on ACCEPTED | `resolveScan`, `handleScan` |
| 6. In-batch ordering | scans processed in order, each changes the db before the next, so a batch sees its own taps | `device.js:submitScans` |
| 7. Serialization | all writes run under the script lock, so two requests cannot both insert | `Server.gs:handleRequest_` |
| 8. Corrections | update the existing row; a manual row is created only when none exists | `portal.js:correctAttendance` |

**ScanLog vs Attendance:** ScanLog = one row for every new scan, any result (audit of taps, incl. rejects and unregistered UIDs). Attendance = only ACCEPTED taps (plus manual correction rows). `ScanLog.attendance_id` links them. ScanLog has no `time_quality` or `card_id` column.

### 2.6 Device API (`handlers/device.js`, `auth/device-auth.js`)

**Authentication (`authenticateDevice`)**, in order:
1. `device_id` and `device_key` must be non-empty strings → else `BAD_REQUEST`.
2. Always compute `deviceKeyHash(key)`; unknown device OR hash ≠ stored (constant-time compare) → `INVALID_DEVICE_KEY` (same error for both).
3. status ≠ active → `DEVICE_DISABLED`.
4. no room → `DEVICE_NOT_ASSIGNED`.

**device.submitScans**

| Item | Value |
|---|---|
| Request | `{sent_at, firmware_version?, scans:[{scan_id, rfid_uid, scanned_at, time_quality, sync_mode}]}` |
| Validation (any bad item → `BAD_REQUEST` for the whole request) | `sent_at` integer ≥ 0; 1 ≤ scans ≤ 20; scan_id = own `device_id-NNNNNN-NNNNNN`; rfid_uid normalized (uppercase, strip space/colon/dash) and matches `^([0-9A-F]{8}|[0-9A-F]{14}|[0-9A-F]{20})$` (4/7/10-byte UIDs); scanned_at integer ≥ 0; time_quality ∈ {ntp, backfilled, unverified}; sync_mode ∈ {live, offline} |
| Per scan | (1) ScanLog has scan_id → ALREADY_RECORDED. (2) Find active card by UID and its active student. (3) `time_quality = unverified` or `scanned_at = 0` → INVALID_TIME. (4) No card/student → UNREGISTERED. (5) Else `resolveScan`. (6) ACCEPTED → push new session (if any) + Attendance row (`status present`, `source device`, `scanned_at` Manila ISO of tap time, `received_at` server now). (7) Always push a ScanLog row |
| Per scan reply | `{scan_id, result, attendance_status: 'PRESENT' or '', final: true, lcd_line2}`; `lcd_line2` = "F. Lastname" ≤ 16 chars only for ACCEPTED/DUPLICATE; ALREADY_RECORDED copies the original's fields + `original_result` |
| Side effects | `Devices.last_seen_at = now`; `firmware_version` updated if 1–32 chars (bad value ignored) |
| Reply | `{results[], roster_version}` |
| `final` | always `true` (no RETRY_LATER result exists) |

**device.heartbeat** — every field required: `battery_voltage` number 0–6; `wifi_rssi` integer −127..0; `queue_count` integer ≥ 0; `time_synced` boolean; `firmware_version` 1–32 chars (trimmed); `uptime_seconds` integer ≥ 0 (validated, not stored). Stores battery rounded to 2 dp, rssi, queue_count, time_synced, firmware_version, `last_heartbeat_at = last_seen_at = now` on its own row only. **No AuditLog row.** Returns `{roster_version, low_battery: stored_volts < low_battery_voltage}`.

**device.getRoster** — read-only, no lock. `Number(known_version) === roster_version` → `{changed:false, roster_version}`. Else `{changed:true, roster_version, settings:{duplicate_window_minutes, heartbeat_interval_seconds}, cards:[{uid, name}]}` for **active cards of active students**, name = LCD short name.

**roster_version bump rules** (`utils.js:bumpRosterVersion`, +1; no-op if the row is missing):

| Trigger | Where |
|---|---|
| Card assign or replace | `students.js:assignCard` |
| Card revoke | `students.js:revokeCard` |
| Any student status change (activate or deactivate) | `students.js:setStudentStatus` |
| Student first or last name change | `students.js:updateStudent` |
| `duplicate_window_minutes` or `heartbeat_interval_seconds` changed | `settings.js:updateSettings` |

**Online / offline** (`dashboard.js:deviceSummaries`, non-retired devices only):
```
online = last_seen_at ≠ '' AND (now − parse(last_seen_at)) ≤ device_offline_after_minutes × 60,000 ms
low_battery = battery_voltage ≠ '' AND battery_voltage < low_battery_voltage
```
`last_seen_at` is set by heartbeat and submitScans (not by getRoster).

**Device admin rules** (`devices.js`): new device starts `maintenance`, no key; name 1–80 chars; notes ≤ 500; activating needs a key (`NO_DEVICE_KEY`) and a free room (`ROOM_HAS_ACTIVE_DEVICE`: only ONE active device per room, also checked on room change of an active device); `retired` is final (`DEVICE_RETIRED` on any later change) and clears the key hash; same status/room → `NO_CHANGE`; lists never return `device_key_hash` (only `has_key`).

### 2.7 Attendance corrections (`portal.js:correctAttendance`)

Shared by `instructor.correctAttendance` (extra ownership + `CLASS_INACTIVE` check) and `admin.correctAttendance` (no ownership check).

| # | Check | Error |
|---|---|---|
| 1 | session exists | NOT_FOUND |
| 2 | instructor only: own class (`FORBIDDEN`) and class active | CLASS_INACTIVE |
| 3 | session not cancelled | SESSION_CANCELLED |
| 4 | phase ≠ upcoming | SESSION_NOT_STARTED |
| 5 | student in roster (enrolled + active) | NOT_ENROLLED |
| 6 | status ∈ {present, late, absent}; reason (cleaned) 5–500 chars | VALIDATION_ERROR |
| 7 | no row and status = absent (would change nothing) | VALIDATION_ERROR (`fields.status`) |
| 8 | current status = requested | VALIDATION_ERROR |

Write: existing row → set `override_status, override_by = user_id, override_at, override_reason` (device fields never edited, row never deleted, so a retried scan_id still finds it). No row → new Attendance row `source manual`, `status` = requested, `scanned_at` = session date + scheduled start, `created_by` = user, `override_reason` = reason. Then AuditLog `ATTENDANCE_CORRECT`, entity `<session_id>:<student_id>`, before/after status, reason.
Students see `correction: {reason, at, by_role: 'Instructor'|'Admin'}`, never a user id or name (`portal.js:correctionOf`).

### 2.8 Audit log (`utils.js:writeAudit`)

Row: `audit_id (AUD-NNNN), timestamp (Manila ISO), user_id, role, action, entity_type, entity_id, before_json, after_json, reason`. System jobs use `user_id ''`, `role 'system'`.
Actions written: LOGIN_SUCCESS, LOGIN_FAILED (reason: unknown username / wrong password / account locked / account disabled / temporary password expired; the attempted username is NOT stored), ACCOUNT_LOCKED, PASSWORD_CHANGED, PASSWORD_RESET, USER_UNLOCKED, BOOTSTRAP_ADMIN, STUDENT_CREATE/UPDATE/ACTIVATE/DEACTIVATE, CARD_ASSIGN/REPLACE/REVOKE, INSTRUCTOR_CREATE/UPDATE/ACTIVATE/DEACTIVATE, ADMIN_CREATE/UPDATE/ACTIVATE/DEACTIVATE, TERM_CREATE/UPDATE/SET_ACTIVE, `<ENTITY>_ACTIVATE/DEACTIVATE` (programs, sections, subjects, rooms), CLASS_CREATE/UPDATE/ACTIVATE/DEACTIVATE, SCHEDULE_CREATE/REMOVE, ENROLL_ADD/DROP, DEVICE_CREATE/UPDATE/STATUS/ASSIGN_ROOM/KEY_GENERATE, UPDATE_SETTINGS, ATTENDANCE_CORRECT, LIVE_TEST_SCHEDULE.
Never written: passwords, temp passwords, device keys, `device_key_hash`. Heartbeats and scans are not audited (ScanLog covers scans). Portals never read AuditLog.

### 2.9 Settings validation (`settings.js:updateSettings`)

`{changes:{key:value}}`, all-or-nothing: unknown key → "cannot be changed"; whole-number keys must match `^\d+$`, decimal keys `^\d+(\.\d{1,2})?$`; value within [min, max] (§1.3); any error → `VALIDATION_ERROR` with fields named by key, nothing saved. Unchanged values are skipped. Decimal values stored with 2 dp. One `UPDATE_SETTINGS` audit row with before/after of changed keys. Returns the new list, `changed`, `roster_version_bumped`.

### 2.10 Reports and filters

**dateRange(request)** (`utils.js`): optional `from`, `to` (YYYY-MM-DD, inclusive, Manila); '' = no bound. Invalid date → `fields.from` / `fields.to`; `from > to` or `to − from + 1 > 366` days → `fields.to`. Returns `has(date) = (!from || date ≥ from) && (!to || date ≤ to)`. Used by student.getHistory/getOverview, instructor.listSessions/getClassRoster/getStudentHistory/getClassReport, admin.listAttendance/getAttendanceReport; validated after the ownership check.

**admin.listAttendance** (`attendance.js`): filters from/to (session date), class_id, section_id (the class's section), student_id, status (effective; ∈ present/late/absent). Sort `scanned_at` desc then `attendance_id` desc. `page` default 1, `page_size` default 100, clamped to 500; non-integer or < 1 → `VALIDATION_ERROR`. Returns `{range, page, page_size, total, rows}`; each row has effective `status` and original `device_status`.

**Other pagination clamps:** `admin.listStudents` page_size 1–100 (default 20, silently clamped); `instructor.getRecentActivity` limit default 20, max 50 (< 1 → VALIDATION_ERROR), returns `has_more`; dashboard recent scans 10; unregistered UID list 20.

**admin.getAttendanceReport** `{group_by, from?, to?, class_id?, section_id?}`:
1. `group_by` ∈ {class, section, student} else `VALIDATION_ERROR`.
2. For each class (filtered by class_id / section_id): sessions = counted sessions in range; skip the class if it is inactive AND has no counted session in range.
3. roster = `rosterIds`; held = `heldCount`.
4. Group key: class → class_id; section → class.section_id (label "PROGRAM_CODE SECTION"); student → each roster student (one group per student across classes).
5. Per group sum `sessions_held`, `present/late/absent/not_scanned` (via `sessionCounts`), `enrolled` = distinct students (student group: number of classes).
6. `total = present + late + absent`, `rate` = formula in §2.4. Sorted by label. `totals` = sums.
7. Also `devices` (queue_count, last_seen_at, online) and `pending_offline_scans = Σ queue_count`.

**Schedule clash detection** (`classes.js:overlaps`, `scheduleClash`; `maintenance.js:findScheduleClashes`):
```
overlaps(a, b) = a.day_of_week == b.day_of_week AND a.start_time < b.end_time AND b.start_time < a.end_time
```
Half-open intervals: back-to-back slots (10:00 end, 10:00 start) do NOT clash. A clash = overlapping ACTIVE schedule of another ACTIVE class in the SAME term sharing the room, the instructor or the section. Checked on addSchedule (also against the class's own slots), updateClass (new instructor), setClassStatus→active. `findScheduleClashes` (editor-only) lists existing clashes with the same rule.

**Other admin validation highlights:** student number exactly 10 digits, unique, also unique as a username; names ≤ 60 chars `^\p{L}[\p{L}\p{M} .'-]*$`; email optional, ≤ 120, unique across Users; username `^[a-z0-9._-]{3,32}$`; term dates valid, end > start, no overlap with another term, cannot move a term so recorded sessions fall outside; one active class per (term, subject, section); a new class auto-enrolls all active students of the section; a new or section-changed student is auto-enrolled in the active classes of the section in the active term (old section's classes → dropped, attendance kept); card UID cannot be reused if it was ever registered to another student; replacing a card needs a reason (lost → `lost`, damaged/other → `revoked`); deactivating a student revokes their active card; deactivation is refused while dependents exist (`IN_USE`: e.g. instructor with active classes, room with active schedules or a non-retired device, last active admin, own admin account); schedules and enrollments are never deleted (set inactive / dropped).

### 2.11 Error model (`utils.js:AppError`)

Handlers throw `AppError(code, message, fields?)`; Server.gs returns `{ok:false, error:{code, message, fields}}` and saves nothing (except login failures).

| Code | Meaning |
|---|---|
| BAD_REQUEST | malformed JSON / missing or invalid field (incl. any bad device field) |
| UNKNOWN_ACTION | action not in the table |
| NOT_SIGNED_IN | no / bad / expired / revoked token, or user inactive |
| FORBIDDEN | wrong role, not owner, or account not linked |
| PASSWORD_CHANGE_REQUIRED | must change the temp password first |
| VALIDATION_ERROR | form errors, `fields` = {field: message} |
| NOT_FOUND / NO_CHANGE / IN_USE | missing record / already in that state / dependents block it |
| INVALID_CREDENTIALS / ACCOUNT_LOCKED / ACCOUNT_DISABLED / TEMP_PASSWORD_EXPIRED | login outcomes |
| NOT_CONFIGURED | Script Property (e.g. PASSWORD_PEPPER) missing |
| INVALID_DEVICE_KEY / DEVICE_DISABLED / DEVICE_NOT_ASSIGNED | device auth |
| DEVICE_RETIRED / NO_DEVICE_KEY / ROOM_HAS_ACTIVE_DEVICE | device admin |
| CLASS_INACTIVE / SESSION_CANCELLED / SESSION_NOT_STARTED / NOT_ENROLLED | corrections |
| STUDENT_INACTIVE / NO_ACTIVE_CARD | card admin |
| ADMIN_EXISTS / NOT_TEST_SHEET / NO_LIVE_TEST_SLOT | editor-only jobs |
| SERVER_BUSY | lock not acquired within 10 s |
| SERVER_ERROR | unexpected exception (logged) |

Frontend-only codes (`api.js`): API_NOT_CONFIGURED, TIMEOUT, NETWORK_ERROR, HTTP_ERROR, BAD_RESPONSE, UNKNOWN_ERROR.

### 2.12 Editor-only maintenance jobs (`Server.gs`, `maintenance.js`, `auth/migration.js`)

| Job | Purpose | Guard |
|---|---|---|
| setupEmptySheets | creates missing tabs/columns (plain text), missing Settings rows with defaults, View tabs; idempotent, never changes existing cells | refuses if TEST_SEED_PASSWORD is set |
| setupSheets | TEST: fills EMPTY tabs with fake seed data, seeds test passwords | requires PASSWORD_PEPPER + TEST_SEED_PASSWORD |
| createBootstrapAdmin | first admin from BOOTSTRAP_ADMIN_* | refuses if an active admin exists |
| listScheduleClashes | §2.10 | read-only |
| issueTestDeviceKey, resetTestUserPassword, prepareLiveTest, cleanupLiveTest | TEST tools | TEST_SEED_PASSWORD required |
| benchmarkPasswordHash | times SHA-256 iterations on the real runtime | — |
| checkSetup | prints environment, row counts, which properties are set (never values), warnings | — |

`prepareLiveTest`: adds a temporary active schedule `now − 10 min … now + 60 min` today, for the active-term class with the most enrolled carded students, in a room with an active device, through the normal `addSchedule` clash checks; marked by an AuditLog `LIVE_TEST_SCHEDULE` row; reused while it still covers now. `cleanupLiveTest` sets them inactive.

---

## 3. Security algorithms

### 3.1 Password hashing (`auth/passwords.js`)

| Item | Value |
|---|---|
| Stored format | `v1$<iterations>$<salt hex>$<hash hex>` in `Users.password_hash` |
| Salt | 16 random bytes (32 hex) per hash |
| Pepper | Script Property `PASSWORD_PEPPER` (never in the Sheet) |
| Secret | `S = UTF-8(pepper + "\u0000" + password)` |
| Algorithm | `h0 = SHA-256(UTF-8(salt_hex) ‖ S)`; `h_i = SHA-256(h_{i−1} ‖ S)` for i = 1 … n−1; output hex of `h_{n−1}` |
| Iterations | `PASSWORD_HASH_ITERATIONS = 300` |
| Measured cost | 1.197 ms / iteration in Apps Script (1500 iterations = 1629 ms, 2026-11-18) → ≈ 360 ms / hash (code comment; `benchmarkPasswordHash`) |
| Verify | parse (iterations 1–1,000,000, hex checks), recompute with stored salt + iterations, `constantTimeEqual` (XOR over the longer length, includes length difference) |
| Rehash on login | after a successful login, if stored iterations < current setting → re-hash with the current count. Lowering the setting does not rehash |
| Unknown user timing | login hashes the typed password anyway so response time does not reveal unknown usernames |
| Password policy | 8–128 chars, ≥ 1 letter (`\p{L}`) and ≥ 1 digit, differs from the current one (`account.js:validateNewPassword`) |

**Weakness (honest):** this is a custom iterated SHA-256, not a standard KDF (PBKDF2/HMAC, bcrypt, scrypt, Argon2). 300 iterations is far below current guidance for PBKDF2-SHA256 (hundreds of thousands); the count was chosen to keep a hash ≈ 360 ms on Apps Script, where no faster crypto is available. The secret pepper (stored outside the Sheet) is the main protection if only the Sheet leaks.

### 3.2 Temporary passwords (`passwords.js:generateTempPassword`, `admin-users.js:issueTempPassword`)

- Alphabet: 56 characters `23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz` (no 0 O o 1 l I).
- 10 characters by rejection sampling of random bytes: keep byte b only if b < 224 (= 4 × 56), char = alphabet[b mod 56] → uniform. Entropy = 10 × log2(56) ≈ 58.1 bits.
- Display form `xxxxx-xxxxx`; the hash is of the 10 characters without the dash. While `temp_password_expires_at` is set, login strips `-` and spaces from the typed password.
- Issued on create (student, instructor, admin) and `admin.resetPassword`: sets `must_change_password = TRUE`, `temp_password_expires_at = now + temp_password_days` (default 7 days). Returned once as `temp_password`; never stored or logged.
- Expired temp password → `TEMP_PASSWORD_EXPIRED`, checked only after the password is proven right.
- Reset also clears the lockout and revokes all sessions of that user. An admin cannot reset their own password (`BAD_REQUEST`).
- `changePassword` clears `temp_password_expires_at`, sets `must_change_password = FALSE`, revokes the user's OTHER sessions.

### 3.3 Login and lockout (`auth/account.js:login`)

Check order: pepper configured → user by normalized username (trim, lowercase) → lock → password → account active → temp expiry → success.

| Case | Effect |
|---|---|
| Unknown username | dummy hash; `INVALID_CREDENTIALS`; audit LOGIN_FAILED |
| `locked_until > now` | `ACCOUNT_LOCKED` (minutes left = ceil); attempts not counted, even with the right password |
| Lock expired | counter reset to 0 before checking |
| Wrong password | `failed_attempts += 1`; if ≥ `max_login_attempts` (5): `locked_until = now + lockout_minutes` (15), audit ACCOUNT_LOCKED, `ACCOUNT_LOCKED`; else `INVALID_CREDENTIALS` |
| Right password, account not active | `ACCOUNT_DISABLED` (only revealed to someone who knows the password) |
| Success | counter and lock cleared, optional rehash, new session, `last_login_at` |

All failures throw with `error.commit = true` so the counter, lock and audit row are saved. A wrong current password in `changePassword` is NOT counted toward lockout. Admin `unlockUser` clears counter + lock (`NO_CHANGE` if not locked).

### 3.4 Web session tokens (`auth/session.js`, `auth/context.js`)

- Token = `crypto.randomHex(32)` → 64 hex chars (256 bits requested). In Apps Script the random source is `Utilities.getUuid()` (UUID v4) with the fixed version and variant hex digits dropped (`crypto-apps-script.js:randomHex`), because Apps Script has no crypto RNG API. Whether `getUuid` is cryptographically secure: **UNVERIFIED**.
- Stored: only `token_hash = SHA-256(token)` (hex, no salt: the token is long and random) in AuthSessions with `created_at`, `expires_at = now + session_token_hours` (8 h), `revoked = FALSE`.
- Expiry is absolute (not sliding). Each login prunes AuthSessions rows whose `expires_at` is more than 24 h in the past.
- Logout sets `revoked = TRUE` for that token hash. Deactivating any student, instructor or admin revokes all their sessions; password reset revokes all; password change revokes all others.
- The browser keeps the token in `sessionStorage` (`rfid.session`), so it is per tab and gone when the tab closes.

### 3.5 Device keys (`devices.js:issueDeviceKey`, `context.js:deviceKeyHash`)

- Key = `randomHex(32)` = 64 hex chars (256 bits), returned ONCE as `device_key`; a new key replaces the old one at once; retiring clears it.
- Stored: `device_key_hash = SHA-256(pepper + "\u0000" + key)`, ONE iteration, compared in constant time.
- Why it differs from passwords: the key is long and random, so it cannot be guessed and needs no slow hash; the 300-iteration hash would add ≈ 360 ms to every tap.
- `device_key_hash` never leaves the server (lists show `has_key`) and is never put in AuditLog.

### 3.6 Authorization

- RBAC: every action has one role (`public`, `any`, `admin`, `instructor`, `student`), enforced only on the server (`runAction`). Frontend checks are navigation only.
- Ownership: instructor and student handlers get their identity from `Users.linked_id` of the signed-in `session.user_id` (`portal.js:linkedId`), never from request fields. Instructor actions check `class.instructor_id` (`ownClass` → `FORBIDDEN`); students only see classes they are enrolled in (`student.getHistory` with another class → `FORBIDDEN`; a `student_id` in the request is ignored).
- `must_change_password` gate (§2.1).

### 3.7 Output safety

- CSV injection (`frontend/assets/js/components/attendance-ui.js:csvText`): a cell starting with `= + - @` gets a leading `'`; cells containing `" , CR LF` are quoted with `""` escaping; file starts with a UTF-8 BOM.
- HTML: `ui.js:escapeHtml` escapes `& < > " '` for API strings put in templates.
- Responses never include `password_hash` or `device_key_hash` (tests check this; live leak scan over 84 replies found none **(doc: RELEASE_READINESS §2 #57–59)**).

### 3.8 Known security weaknesses (from code + docs)

| Weakness | Source |
|---|---|
| 300-iteration custom SHA-256 (§3.1) | `passwords.js` |
| RNG = UUID v4 (secure source UNVERIFIED) | `crypto-apps-script.js` |
| Firmware does not check the TLS certificate (`client.setInsecure()`, TODO root CA) | `rfid_attendance.ino:postJson` |
| Public login takes the write lock and can lock any account by guessing; student usernames (student numbers) are guessable; no rate limit | `account.js`; FINAL_BACKEND_REVIEW M4 (doc) |
| `changePassword` does not rate-limit the old-password check | RELEASE_READINESS §6 (doc) |
| RFID UIDs are not strong proof of identity (cards can be cloned) | RELEASE_READINESS §6 #14 (doc) |
| Web App deployed as "anyone, anonymous" (needed by devices); auth is in code | FINAL_BACKEND_REVIEW P8 (doc) |
| No SRI on CDN script tags | RELEASE_READINESS §6 (doc) |
| Device key and Wi-Fi password are compiled into the firmware (`secrets.h`, git-ignored) | firmware |

---

## 4. Frontend (logic only)

### 4.1 API client (`frontend/assets/js/api.js:callApi`)

| Item | Logic |
|---|---|
| Request | `POST CONFIG.API_URL`, header `Content-Type: text/plain;charset=utf-8` (a "simple" CORS request, no preflight, which Apps Script cannot answer), body `JSON.stringify({action, session_token, ...payload})` |
| Token | from `sessionStorage['rfid.session']` (`session.js:getSession`); `null` when signed out |
| Timeout | `AbortSignal.timeout(45000)` → `TIMEOUT` |
| Transport errors | fetch fails → `NETWORK_ERROR`; HTTP not ok → `HTTP_ERROR`; bad JSON → `BAD_RESPONSE`; no API_URL → `API_NOT_CONFIGURED` |
| Server error | `ok !== true` → throws `ApiError(code, message, fields)` |
| `NOT_SIGNED_IN` | clears the session, sets a one-time "session expired" note, redirects to the login page |
| `PASSWORD_CHANGE_REQUIRED` | marks the stored session `must_change_password = true`, redirects to login (which opens the change form) |
| Client-side expiry | `getSession` drops a session whose `expires_at ≤ Date.now()` and shows the expired note |

### 4.2 Login flow (`index.html`, `pages/login.js`, `auth-forms.js`, `auth.js`)

1. If a valid session exists and no password change is pending → redirect to the role home (`admin/`, `instructor/`, `student/`).
2. Sign-in form → `auth.login {username, password}` → session saved in sessionStorage (fails visibly if storage is blocked).
3. `must_change_password` → the change form opens with the old password pre-filled; new + confirm must match (client check) → `auth.changePassword` → session updated → role home. A reload resumes the pending change; "sign in as someone else" clears the local session (does not call `auth.logout`).
4. Errors show the first field message or the server message; `TEMP_PASSWORD_EXPIRED` has its own text.
5. "Forgot password" view is static text: contact the administrator; no email reset, no API call.

### 4.3 Guards (`auth.js:requireRole`)

No session or pending password change → login page; wrong role → that role's home. Navigation only; the server re-checks everything. Logout = `auth.logout` (errors ignored) + clear session + go to login.

### 4.4 Pages and the actions they call

| Portal / page | What it does | Actions |
|---|---|---|
| Admin dashboard | stats for a date, sessions of the date (incl. scheduled slots), devices, last 10 scans, alerts | admin.getDashboard |
| Admin students | search/filter (status, section, with/without card), paging, create (shows temp password once), edit, activate/deactivate with reason, assign/replace/revoke card, pick from recently seen unregistered UIDs, reset/unlock login | admin.getStudentOptions, listStudents, getStudent, createStudent, updateStudent, setStudentStatus, assignCard, revokeCard, listUnregisteredUids, resetPassword, unlockUser |
| Admin instructors / admins | list, search, status filter, create (temp password), edit, activate/deactivate, reset password, unlock | admin.list/create/update/set…Status Instructor(s)/Admin(s), resetPassword, unlockUser |
| Admin academic | terms (incl. set active), programs, sections, subjects, rooms | admin.list/create/update/setStatus × 5, setActiveTerm |
| Admin classes | list by term, create (auto-enrolls section), change instructor, activate/deactivate, add/remove schedule, enroll/drop students | admin.listClasses, getClassOptions, getClass, createClass, updateClass, setClassStatus, addSchedule, removeSchedule, enrollStudents, dropEnrollment |
| Admin devices | list (with offline threshold from settings), create, edit, status, assign room, generate key (shown once) | admin.listDevices, listRooms, getSettings, createDevice, updateDevice, setDeviceStatus, assignDeviceRoom, generateDeviceKey |
| Admin attendance — Records tab | filters (date range, class, section, student by number, status), 100 rows per page, correct a row, add a manual record (sessions of a date from the dashboard action, roster from getClass), CSV export | admin.listAttendance, listClasses, getClassOptions, listStudents, correctAttendance, getDashboard, getClass |
| Admin attendance — Reports tab | group by class/section/student + range + class/section filters, CSV export | admin.getAttendanceReport |
| Admin settings | edit the 10 settings with min/max/decimal from the server | admin.getSettings, updateSettings |
| Instructor dashboard | sessions of a date, class summaries, watchlist, recent activity (limit 10) | instructor.getDashboard, getRecentActivity |
| Instructor attendance | pick class (incl. past classes), session list with date range, session detail, correct a student with reason | instructor.listSessions, getSession, correctAttendance |
| Instructor class roster / student history (dialogs) | roster with per-student totals, one student's history | instructor.getClassRoster, getStudentHistory |
| Instructor reports | class report with range, per-student marks, CSV export | instructor.getClassReport |
| Student dashboard | profile, today's classes, totals, per-subject rates, 6 recent | student.getOverview |
| Student history | filter by class and date range, shows correction reason and corrector role | student.getHistory |
| Student profile | profile, masked card UID (`•••• last4`), enrolled classes | student.getProfile |
| Account (all roles) | own account info, change password | auth.me, auth.changePassword |

All 76 user actions are referenced by at least one frontend file (checked by script).

### 4.5 CSV export with paging (`pages/admin-attendance.js:exportRecords`)

Loop: `page = 1, 2, …` calling `admin.listAttendance` with `page_size 500` (backend max) until `rows.length ≥ total`; a progress note shows "Fetching records… n of total"; on error the export stops and says how many rows were fetched. Instructor and report exports are built from the already-loaded report data (no extra calls). File names include the Manila date or range.

### 4.6 Loading and error states

Each page shows a loading state, an error state with the server message (`ui.js:errorStateHtml`), an empty state, and field errors under the form fields from `error.fields` (`ui.js:showFieldErrors`). Pages do not auto-refresh (only the top-bar clock ticks every 15 s, `ui.js:startTopbarClock`). UNVERIFIED: per-page details of retry buttons were not read line by line.

---

## 5. ESP32 firmware (`firmware/rfid_attendance/rfid_attendance.ino`, v0.4.0, "Stage 1 (online)")

Present in the working tree but **not committed** (`git status: ?? firmware/`). `secrets.h` (git-ignored) defines WIFI_SSID, WIFI_PASS, API_URL, DEVICE_ID, DEVICE_KEY.

| Item | Logic / constant |
|---|---|
| Hardware | ESP32 + MFRC522 (SPI: SS 14, SCK 27, MOSI 23, MISO 19, RST 26), 16×2 I2C LCD at 0x27 (SDA 21, SCL 22), green LED 33, red LED 32, buzzer 25 |
| Boot | init peripherals → `boot_count` += 1 in NVS (Preferences "rfid") → Wi-Fi connect (≤ 15 s) → NTP sync (`pool.ntp.org`, `time.google.com`, UTC, ≤ 15 s; synced = epoch > 1,700,000,000) → heartbeat → "Tap your ID" |
| UID | bytes → uppercase hex, no separators |
| scan_id | `DEVICE_ID-%06lu(boot_count)-%06lu(sequence)`; sequence starts at 0 each boot (unique because boot_count grows) |
| Tap decision (loop) | same UID within 5 min of the last ACCEPTED/DUPLICATE → "Already scanned" (not sent); no Wi-Fi → "No Wi-Fi / Tap again later"; clock not synced → re-sync + "Clock not ready"; else send |
| Send | one `device.submitScans` with 1 scan, `time_quality ntp`, `sync_mode live`, `sent_at = scanned_at = time(nullptr)`; "Processing..." shown while waiting |
| HTTP | POST JSON (`Content-Type: application/json`) without following redirects; on 301/302/303/307 GET the `Location` with a new TLS client; 20 s timeouts; `setInsecure()` |
| Feedback | ACCEPTED: "Recorded" + name, green, 150 ms beep. DUPLICATE: "Already recorded", 2 beeps. UNREGISTERED: UID on LCD for 10 s, red, 700 ms beep. NOT_ENROLLED / NO_ACTIVE_SESSION / SESSION_CANCELLED / INVALID_TIME: message, red, long beep. ALREADY_RECORDED → shows original_result. Device auth errors → "Device error", 3 beeps. Other `ok:false` → "Server busy". No reply → "Not saved / Tap again later". Result shown 3 s |
| Wi-Fi | reconnect attempt every 30 s, non-blocking |
| Heartbeat | every 5 min, BUT disabled while `HAS_BATTERY_SENSE = false` (no made-up battery value); `queue_count` always 0 |
| Offline queue | **not implemented** (Stage 2: LittleFS queue + `device.getRoster`); a failed send is lost and the student must tap again |
| Roster / server settings | `device.getRoster` not called; `duplicate_window` hard-coded 5 min; `roster_version` ignored |

---

## 6. Tests and measurements

### 6.1 Automated tests (run 2026-11-25: `node --test`)

**621 tests, 117 suites, 621 pass, 0 fail, ≈ 6.7 s.** No npm dependencies. In-memory db (`tests/helpers/db.js`), node:crypto adapter + fake clock (`helpers/auth.js`), and a fake Apps Script + Sheets API that runs the real `Server.gs` + `Bundle.gs` in a VM and counts tabs/rows read and written (`helpers/fake-apps-script.js`).

| Area | Test files (approx. test count by `test(`/`it(` grep) |
|---|---|
| Server.gs path (load/save, lock, batchUpdate, blank headers, commit-on-failure) | server-gs (60) |
| Device scans, idempotency, sessions | submit-scans (35), sessions (25), heartbeat-roster (13), devices (26) |
| Auth and accounts | auth (26), passwords (13), temp-passwords (18), users (17), migration (10) |
| Counting and portals | portal (15), attendance-override (10), enrolled-later (4), past-classes (3), student-corrections (4), verification (14) |
| Admin | admin-attendance (19), admin-corrections (8), classes (14), cards (11), section-change (9), settings (21), date-filters (23) |
| Infrastructure | actions (7), tabs (10), clock (7), production-setup (8), maintenance (4), live-test (11), live-device-tool (4), wrapup-fixes (16) |
| Frontend helpers (CSV, badges) | attendance-ui (15) |

Grep counts are approximate (nested/parameterized tests); the runner total 621 is exact.

### 6.2 Local measurements (run 2026-11-25, fake Apps Script, Node)

`node tools/measure_device_api.mjs`:

| Action / data | Tabs read | Rows read | Rows written | batchUpdates |
|---|---|---|---|---|
| submitScans, 1 scan, seeded TEST data (ScanLog 62, Attendance 56) | 11 | 231 | 4 | 1 |
| submitScans, 20 scans, seeded | 11 | 231 | 27 | 1 |
| submitScans, 1 scan, padded 5,000 ScanLog + 5,000 Attendance | 11 | 10,113 | 4 | 1 |
| submitScans, 20 scans, padded | 11 | 10,113 | 27 | 1 |
| heartbeat (seeded or padded) | 2 | 17 | 1 | 1 |
| getRoster (full or unchanged) | 4 | 49 | 0 | 0 |

`node tools/measure_admin_reports.mjs`:

| Action | Attendance rows | Tabs read | Rows read |
|---|---|---|---|
| listAttendance | 56 / 5,000 | 7 | 121 / 5,065 |
| getAttendanceReport (any group_by) | 56 / 5,000 | 14 | 180 / 5,124 |

1 accepted scan writes 4 rows (Attendance + ScanLog + new ClassSession + Devices row).

### 6.3 Live measurements on the deployed TEST Web App (doc: `docs/RELEASE_READINESS.md`, 2026-11-24)

`tools/live_device_test.mjs`, ms per request:

| Test | Result | ms |
|---|---|---|
| heartbeat | PASS | 3180 |
| getRoster (known_version 0) | PASS, 14 cards | 2715 |
| live scan → ACCEPTED | PASS | 3350 |
| same scan_id → ALREADY_RECORDED | PASS | 2470 |
| new scan_id, same student → DUPLICATE | PASS | 2963 |
| NOT_ENROLLED / UNREGISTERED | PASS | 2431 / 3398 |
| 20-scan batch (2 ACCEPTED, 18 DUPLICATE) | PASS | 3684 |
| wrong key → INVALID_DEVICE_KEY | PASS | 2310 |
| 40 sequential (min / median / max) | PASS | 2313 / 3227 / 5777 |
| 10 parallel (8 DUPLICATE, 2 SERVER_BUSY) | PASS | 2488 / 7349 / 12657 |

Full live scenario: 61 checks, 58 PASS, 3 FAIL (2 = stale deployment lacking the `correction` field, 1 = minor UI view-transition error). Verdict in that doc: NO-GO until redeploy. Typical request latency **(doc: Device_API_Spec §3.2)**: ≈ 2.3–3.7 s, median ≈ 3 s.

Password hash timing: 1.197 ms per SHA-256 iteration, 1500 iterations = 1629 ms, ⇒ ≈ 359 ms at 300 iterations (code comment, measured 2026-11-18).

---

## 7. Status table

| Feature | Status | Tested |
|---|---|---|
| Sheet schema, plain-text storage, View tabs | IMPLEMENTED | yes (server-gs, production-setup) |
| Declared-tab loading, one batchGet, one batchUpdate, lock | IMPLEMENTED | yes (server-gs, tabs) |
| Username/password login, lockout, temp passwords, forced change | IMPLEMENTED | yes + live |
| Session tokens (hashed, expiry, revocation) | IMPLEMENTED | yes + live |
| RBAC + ownership | IMPLEMENTED | yes + live |
| Admin CRUD: students, instructors, admins, academic, classes, schedules, enrollments | IMPLEMENTED | yes |
| Cards (assign/replace/revoke, unregistered UID list) | IMPLEMENTED | yes |
| Devices admin + device key auth | IMPLEMENTED | yes + live |
| Session engine (schedule-based, lazy session creation, tie-breaker) | IMPLEMENTED | yes + live |
| device.submitScans (batch, idempotent) | IMPLEMENTED | yes + live |
| device.heartbeat / device.getRoster (server) | IMPLEMENTED | yes + live |
| Absent computed at session end (no trigger) | IMPLEMENTED | yes + live |
| Corrections (instructor + admin), reason shown to students | IMPLEMENTED | yes; live student view FAILED on the stale deployment |
| Reports (instructor, admin grouped), date filters, CSV | IMPLEMENTED | yes + live |
| Admin settings | IMPLEMENTED | yes |
| Schedule clash checks + editor clash list | IMPLEMENTED | yes |
| Manual sessions (start / extend / cancel / close) | PARTIAL: the engine honors `source=manual` and `cancelled`/`closed` sessions, but **no action creates, cancels or closes a session**; only via hand-editing the Sheet | engine only |
| LATE on tap | ONLY PLANNED → removed (tap is always PRESENT); `late` only via correction | — |
| Firmware Stage 1 (online taps, feedback, cooldown) | IMPLEMENTED, uncommitted | no automated test; live hardware result UNVERIFIED |
| Firmware heartbeat | PARTIAL: code present, disabled until the battery divider is wired | — |
| Firmware offline queue (LittleFS), backfilled time, getRoster, TLS root CA | ONLY PLANNED (Stage 2) | — |
| Term-size speed check (40 taps / 2 min on a full term Sheet) | ONLY PLANNED | — |
| Production deployment | ONLY PLANNED (docs/PRODUCTION_SETUP.md); live TEST Web App runs an older bundle | — |

### Known limitations

| Limitation | Source |
|---|---|
| ≈ 2.3–4.3 s per request on Apps Script; 12.7 s worst case with 10 parallel requests | live test (doc) |
| One script lock for all writes (logins, taps, admin edits) → `SERVER_BUSY` under bursts | `Server.gs` |
| `device.submitScans` reads ALL of ScanLog + Attendance per request (≈ 10k rows at 5k each); cost grows with the term | measure tool |
| All reads load whole tabs; Sheets has a 10 M cell limit per spreadsheet and 50,000 chars per cell (doc / Google) | `Server.gs` |
| Firmware heartbeat off → a device with no taps shows offline after `device_offline_after_minutes` (10) | firmware + `deviceSummaries` |
| No offline queue → a tap during Wi-Fi or server failure is lost | firmware |
| Reports count only currently enrolled + active students; dropping/deactivating changes past numbers; dropped classes vanish from the student's history | `portal.js:rosterIds`, `myEnrolledClasses` |
| Re-enrolled student keeps the old `enrolled_at` | `classes.js:enroll` |
| Admin dashboard rate counts not_scanned mid-class (portals do not) | `dashboard.js` |
| Instructor dashboard hides sessions whose schedule was removed | `portal.js:instructorDashboard` |
| "View - Attendance" labels any non-device row "Instructor correction", also admin rows | `Server.gs:setupViews` |
| Concurrent manual edits in the Sheet are not locked; sorting raw tabs breaks the last-row id rule | `Server.gs` comments |
| A batchUpdate that times out after Google applied it is reported as an error although saved | `Server.gs:saveDb_` comment |
| `recordOf` cache is rebuilt only on row-count change | `portal.js` shortcut comment |

---

## 8. Removed features (one line each)

- Google Sign-In: replaced by admin-created username/password accounts.
- Test sign-in (`ALLOW_TEST_LOGIN`) and shared default passwords (`DEFAULT_*_PASSWORD`): removed; random temporary passwords instead.
- Demo mode (in-browser fake backend): removed; the site uses the live API only.
- `late_grace_minutes` / automatic LATE: removed; a tap is always PRESENT.

---

## 9. Code vs docs disagreements (code wins)

| # | Doc says | Code does |
|---|---|---|
| 1 | BACKEND_VERIFICATION §Part 2 summary and FINAL_BACKEND_REVIEW header: "No firmware is in this repo" | `firmware/rfid_attendance/` exists (v0.4.0), uncommitted |
| 2 | BACKEND_VERIFICATION D3: `students_present` "counts by the Manila date in `scanned_at`" (`dashboard.js:76-78`) | Counts students present/late in the sessions listed for the date (`presentIds` in `getAdminDashboard`), not by `scanned_at` |
| 3 | BACKEND_VERIFICATION Part 2: `historyRows` filters `status !== 'scheduled'` (dead condition) | No such filter in `portal.js:historyRows`; filters `statusFor(...) !== null` |
| 4 | FINAL_BACKEND_REVIEW P1: `setupEmptySheets` "refuses if any data tab already has rows" | Idempotent: adds missing tabs/columns/Settings rows, never refuses on data; refuses only if TEST_SEED_PASSWORD is set |
| 5 | FINAL_BACKEND_REVIEW P2: "the 12 keys from the seed" | DEFAULT_SETTINGS has 11 rows (10 editable + roster_version) |
| 6 | Architecture doc (F1, F5, §4.3, Users `google_sub`, Attendance `present/late`): Google Sign-In, late grace, LATE on tap | Password login; tap always present; no `google_sub` column (the doc itself says CLAUDE.md supersedes it) |
| 7 | Device_API_Spec §7 / §7.1: device queues failed scans, heartbeat in every cycle with `queue_count`, uses getRoster's `duplicate_window_minutes` | Firmware: no queue (scan lost, "Not saved"), heartbeat disabled, `queue_count` fixed 0, getRoster not called, window hard-coded |
| 8 | Device_API_Spec §3.2: use the Google root CA | Firmware: `setInsecure()` (TODO in code) |
| 9 | Device_API_Spec §7: a failed live tap shows "Saved offline" | Firmware shows "Not saved / Tap again later" (Stage 1) |
| 10 | RELEASE_READINESS §6: "`node_modules/` (Playwright) is tracked in git" | `git ls-files node_modules` = 0 (untracked in commit 6c35152) |
| 11 | Login page text: temporary passwords "last 7 days" (`auth-forms.js:errorResult`) | `temp_password_days` is a setting, 1–30 days |
| 12 | View - Attendance "Recorded by" = "Instructor correction" for every non-device row | Manual rows may be created by admins too (`admin.correctAttendance`) |

UNVERIFIED (not checked against code): every line of `docs/RFID_Attendance_System_Architecture.md` and `docs/PROJECT_CONTEXT.md` beyond the items above; the per-page UI flows beyond the action calls listed in §4.4.
