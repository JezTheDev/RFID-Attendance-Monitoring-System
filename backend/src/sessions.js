// Session engine (step 4c): pure functions, no writes.
// A class starts by SCHEDULE: device -> room; room + day + time -> class.
// Times are compared at minute precision (Sheet times are HH:mm).
import { manilaAt, dayCodeOf, nextId } from './utils.js';

const MAX_FUTURE_SECONDS = 5 * 60;

const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const startOf = (session) => session.actual_start || session.scheduled_start;
const endOf = (session) => session.actual_end || session.scheduled_end;

// now = { date: 'YYYY-MM-DD', time: 'HH:mm' } in Manila (manilaAt(ctx.now())).
export function sessionPhase(session, now) {
  if (session.status === 'cancelled') return 'cancelled';
  if (session.status === 'closed') return 'ended';
  const moment = `${now.date} ${now.time}`;
  if (moment < `${session.session_date} ${startOf(session)}`) return 'upcoming';
  if (moment <= `${session.session_date} ${endOf(session)}`) return 'in_progress';
  return 'ended';
}

// Status of an enrolled student with no attendance row (BUG-7).
export function missingStatus(session, now) {
  return sessionPhase(session, now) === 'ended' ? 'absent' : 'not_scanned';
}

const reject = (result, reason, extra = {}) => ({ result, reason, ...extra });

// scan = { room_id, scanned_at (epoch seconds), student_id }; nowMs = ctx.now().
// Returns a decision; the caller (4d) saves newSession / the attendance row.
export function resolveScan(db, { room_id: roomId, scanned_at: scannedAt, student_id: studentId }, settings, nowMs) {
  const seconds = typeof scannedAt === 'string' && scannedAt.trim() !== '' ? Number(scannedAt) : scannedAt;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0 || seconds > nowMs / 1000 + MAX_FUTURE_SECONDS) {
    return reject('INVALID_TIME', 'The scan time is missing or ahead of the server clock.');
  }
  const { date, time } = manilaAt(seconds * 1000);
  const t = minutes(time);
  const early = Number(settings.early_window_minutes ?? 15) || 0;
  const afterEnd = Number(settings.accept_after_end_minutes ?? 0) || 0;
  const covers = (start, end) => minutes(start) - early <= t && t <= minutes(end) + afterEnd;

  const term = db.Terms.find((row) => row.is_active === 'TRUE' && row.start_date <= date && date <= row.end_date);
  if (!term) return reject('NO_ACTIVE_SESSION', 'No active term on this date.');

  const enrolledIn = (classId) => db.Enrollments.some((row) => row.class_id === classId && row.student_id === studentId && row.status === 'enrolled');
  const hasRecord = (session) => Boolean(session) && db.Attendance.some((row) => row.session_id === session.session_id && row.student_id === studentId);

  // Manual sessions win over the schedule.
  let candidates = db.ClassSessions
    .filter((row) => row.source === 'manual' && row.room_id === roomId && row.session_date === date
      && row.status !== 'cancelled' && covers(startOf(row), endOf(row)))
    .map((row) => ({ classId: row.class_id, start: startOf(row), end: endOf(row), session: row }));

  if (!candidates.length) {
    const day = dayCodeOf(date);
    candidates = db.Schedules
      .filter((row) => row.status === 'active' && row.room_id === roomId && row.day_of_week === day && covers(row.start_time, row.end_time)
        && db.Classes.some((klass) => klass.class_id === row.class_id && klass.status === 'active' && klass.term_id === term.term_id))
      .map((row) => ({
        classId: row.class_id, start: row.start_time, end: row.end_time, schedule: row,
        session: db.ClassSessions.find((s) => s.schedule_id === row.schedule_id && s.session_date === date),
      }));
    if (!candidates.length) return reject('NO_ACTIVE_SESSION', 'No class in this room at this time.');
    candidates = candidates.filter((c) => c.session?.status !== 'cancelled');
    if (!candidates.length) return reject('SESSION_CANCELLED', 'This class session was cancelled.');
  }

  // Tie-breaker (back-to-back classes): enrolled, then no record yet, then in progress, then earlier start.
  const rank = (c) => [enrolledIn(c.classId) ? 0 : 1, hasRecord(c.session) ? 1 : 0, minutes(c.start) <= t && t <= minutes(c.end) ? 0 : 1, minutes(c.start)];
  const byRank = (a, b) => {
    const ka = rank(a);
    const kb = rank(b);
    const i = ka.findIndex((v, n) => v !== kb[n]);
    return i === -1 ? 0 : ka[i] - kb[i];
  };
  const chosen = candidates.slice().sort(byRank)[0];

  const classId = chosen.classId;
  if (!enrolledIn(classId)) return reject('NOT_ENROLLED', 'The student is not enrolled in the class in this room now.', { class_id: classId });

  const target = chosen.session
    ? { session: chosen.session }
    : {
      newSession: {
        session_id: nextId(db.ClassSessions, 'session_id', 'SES'),
        class_id: classId,
        room_id: roomId,
        schedule_id: chosen.schedule.schedule_id,
        session_date: date,
        scheduled_start: chosen.schedule.start_time,
        scheduled_end: chosen.schedule.end_time,
        actual_start: '',
        actual_end: '',
        source: 'auto',
        status: 'open',
        opened_by: '',
        closed_by: '',
        override_reason: '',
        created_at: manilaAt(nowMs).iso,
      },
    };
  if (hasRecord(chosen.session)) return reject('DUPLICATE', 'The student already has a record in this session.', { class_id: classId, ...target });
  return { result: 'ACCEPTED', reason: 'Recorded as present.', class_id: classId, attendance_status: 'present', ...target };
}
