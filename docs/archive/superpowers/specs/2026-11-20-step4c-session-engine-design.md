# Step 4c — Session engine + BUG-7 (short design)

Approved 2026-11-20. Team decisions override architecture §4 where different.

## Why
4d (`device.submitScans`) needs one pure function that turns a tap into a
decision. BUG-7: a student with no record shows "absent" while the class is
still running; with lazy sessions the row stays `status: open` forever, so the
old `status === 'open'` check is wrong.

## Goals / non-goals
- Goals: `resolveScan`, `sessionPhase`, `missingStatus` in `backend/src/sessions.js`;
  BUG-7 fixed everywhere absent is computed; one clock (`ctx.now()`) in portal and dashboard.
- Non-goals: no device action, no Sheet writes, no manual-session UI/actions,
  no automatic late, no frontend change, no rename of `not_scanned`.
- Anti-goal: a test that depends on the real date.

## Approaches
1. **New module `backend/src/sessions.js`** (picked): shared by portal, dashboard and 4d.
2. Inside `portal.js`: dashboard and 4d would import from a handler file. Rejected.
3. Inside `utils.js`: utils grows a domain engine. Rejected.

## Decisions
- `resolveScan(db, { room_id, scanned_at, student_id }, settings, nowMs)`; `scanned_at`
  is epoch **seconds** (Device_API_Spec); `nowMs` = `ctx.now()`.
- Returns `{ result, reason, class_id?, session? | newSession?, attendance_status? }`.
  Results: `ACCEPTED` (`attendance_status: 'present'`), `DUPLICATE`, `NOT_ENROLLED`,
  `NO_ACTIVE_SESSION`, `SESSION_CANCELLED`, `INVALID_TIME`.
- Settings: `early_window_minutes` (default 15), `accept_after_end_minutes` (default 0).
- Times compared at **minute** precision (Sheet times are `HH:mm`): 10:00:59 counts as 10:00.
- Term: `is_active === 'TRUE'`, dates include session_date, and `class.term_id` = that term.
- Manual sessions (`source: manual`, same room/date, not cancelled, covering time
  with the same window) are used instead of schedules when any match.
- Candidates whose existing session is cancelled are dropped; all dropped → `SESSION_CANCELLED`.
- Tie-breaker: enrolled → no record yet → in progress (start ≤ t ≤ end) → earlier start.
- `newSession`: `session_id = nextId(ClassSessions,'session_id','SES')`, start/end copied
  from the schedule, `source: auto`, `status: open`, `created_at` = Manila ISO of now.
- `sessionPhase(session, now)` with `now = { date, time }`: `cancelled` if status cancelled;
  `ended` if status closed; else by `actual_* || scheduled_*`: before start → `upcoming`,
  ≤ end → `in_progress`, after → `ended`.
- `missingStatus(session, now)` → `'absent'` only when ended, else `'not_scanned'`.
- Counts: while not ended `absent: 0` and new `not_scanned: <roster − present − late>`;
  after the end `not_scanned: 0`. Rates never include `not_scanned`.
- Clock: `manilaAt(ms) -> { date, time, iso }` in utils; portal and dashboard
  handlers use `manilaAt(ctx.now())`. `writeAudit` keeps its own clock (out of scope).

## Left to the builder
Reason strings; internal helper names.
