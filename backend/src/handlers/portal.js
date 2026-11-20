// Handlers for the Instructor and Student portals.
// Ownership rule (architecture doc, section 7.2): the server never trusts an
// instructor_id / student_id sent by the browser. It reads linked_id from the
// signed-in user and only returns rows that belong to that person.
import {
  AppError, validationError, manilaAt, dayCodeOf, isValidDate, indexBy, fullName,
  cleanText, writeAudit, nextId, effectiveStatus, dateRange, MAX_TEXT,
} from '../utils.js';
import { missingStatus, sessionPhase } from '../sessions.js';

const DAY_ORDER = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const CORRECTABLE = ['present', 'late', 'absent'];
export const CORRECTION_ACTION = 'ATTENDANCE_CORRECT';

/* ---------------- shared helpers ---------------- */

function linkedId(db, session, role) {
  const user = db.Users.find((row) => row.user_id === session.user_id);
  if (!user || user.role !== role || !user.linked_id) {
    throw new AppError('FORBIDDEN', 'Your account is not linked to a record yet. Contact the administrator.');
  }
  return user.linked_id;
}

export function lookups(db) {
  return {
    classes: indexBy(db.Classes, 'class_id'),
    subjects: indexBy(db.Subjects, 'subject_id'),
    sections: indexBy(db.Sections, 'section_id'),
    rooms: indexBy(db.Rooms, 'room_id'),
    instructors: indexBy(db.Instructors, 'instructor_id'),
    students: indexBy(db.Students, 'student_id'),
    programs: indexBy(db.Programs, 'program_id'),
  };
}

export function sectionLabel(maps, sectionId) {
  const section = maps.sections.get(sectionId);
  if (!section) return '';
  const program = maps.programs.get(section.program_id);
  return `${program?.program_code ?? ''} ${section.section_name}`.trim();
}

function schedulesOf(db, maps, classId) {
  return db.Schedules
    .filter((row) => row.class_id === classId && row.status === 'active')
    .sort((a, b) => DAY_ORDER.indexOf(a.day_of_week) - DAY_ORDER.indexOf(b.day_of_week) || a.start_time.localeCompare(b.start_time))
    .map((row) => ({
      day: row.day_of_week,
      start_time: row.start_time,
      end_time: row.end_time,
      room_code: maps.rooms.get(row.room_id)?.room_code ?? '',
    }));
}

export function rosterIds(db, maps, classId) {
  return db.Enrollments
    .filter((row) => row.class_id === classId && row.status === 'enrolled'
      && maps.students.get(row.student_id)?.account_status === 'active')
    .map((row) => row.student_id);
}

// Sessions that count toward attendance: held (closed) or currently open.
export function countedSessions(db, classId) {
  return db.ClassSessions
    .filter((row) => row.class_id === classId && (row.status === 'closed' || row.status === 'open'))
    .sort((a, b) => a.session_date.localeCompare(b.session_date) || a.scheduled_start.localeCompare(b.scheduled_start));
}

// An open session that has not started yet (early tap) is not held.
export const heldCount = (sessions, now) => sessions.filter((s) => sessionPhase(s, now) !== 'upcoming').length;

// session_id -> student_id -> first row. Rebuilt when rows are added (correctAttendance).
// shortcut: rebuilt only on length change; replacing rows or editing session_id/student_id needs a rebuild.
const attendanceIndex = new WeakMap();
function recordsBySession(db) {
  const rows = db.Attendance;
  let cached = attendanceIndex.get(rows);
  if (!cached || cached.length !== rows.length) {
    const map = new Map();
    rows.forEach((row) => {
      if (!map.has(row.session_id)) map.set(row.session_id, new Map());
      const students = map.get(row.session_id);
      if (!students.has(row.student_id)) students.set(row.student_id, row);
    });
    cached = { length: rows.length, map };
    attendanceIndex.set(rows, cached);
  }
  return cached.map;
}

export function recordOf(db, sessionId, studentId) {
  return recordsBySession(db).get(sessionId)?.get(studentId) ?? null;
}

function correctionKey(sessionId, studentId) {
  return `${sessionId}:${studentId}`;
}

// Corrected rows (device overrides and manual rows) carry the reason in
// override_reason, so the portals never read the ever-growing AuditLog.
function correctionsFor(db, sessionId) {
  const map = new Map();
  db.Attendance
    .filter((row) => row.session_id === sessionId && row.override_reason)
    .forEach((row) => map.set(correctionKey(row.session_id, row.student_id), { reason: row.override_reason }));
  return map;
}

export function statusOf(record, session, now) {
  return record ? effectiveStatus(record) : missingStatus(session, now);
}

// class_id -> student_id -> enrolled_at (same length-change rebuild as recordsBySession).
const enrollmentIndex = new WeakMap();
function enrolledAtOf(db, classId, studentId) {
  const rows = db.Enrollments;
  let cached = enrollmentIndex.get(rows);
  if (!cached || cached.length !== rows.length) {
    const map = new Map();
    rows.forEach((row) => map.set(`${row.class_id}:${row.student_id}`, row.enrolled_at || ''));
    cached = { length: rows.length, map };
    enrollmentIndex.set(rows, cached);
  }
  return cached.map.get(`${classId}:${studentId}`) ?? '';
}

// statusOf for a roster student. null = no row and they joined the class after
// this session ended: never expected there, so not absent and not "not yet".
export function statusFor(db, session, studentId, now) {
  const record = recordOf(db, session.session_id, studentId);
  if (record) return effectiveStatus(record);
  const enrolledAt = enrolledAtOf(db, session.class_id, studentId);
  const ended = `${session.session_date}T${session.actual_end || session.scheduled_end}:00+08:00`;
  return enrolledAt && enrolledAt > ended ? null : missingStatus(session, now);
}

export function rate(present, late, total) {
  return total > 0 ? (present + late) / total : null;
}

export function summarize(statuses) {
  const present = statuses.filter((s) => s === 'present').length;
  const late = statuses.filter((s) => s === 'late').length;
  const absent = statuses.filter((s) => s === 'absent').length;
  const total = present + late + absent;
  return { present, late, absent, total, rate: rate(present, late, total) };
}

// Same rule as statusOf for every view: a row counts by its effective status
// (an override to absent is absent at once); no row is not_scanned until the
// session ends, absent after (BUG-7).
export function sessionCounts(db, session, roster, now) {
  const counted = session.status === 'closed' || session.status === 'open';
  const totals = { present: 0, late: 0, absent: 0, not_scanned: 0 };
  let joinedLater = 0;
  if (counted) {
    roster.forEach((studentId) => {
      const status = statusFor(db, session, studentId, now);
      if (status === null) joinedLater += 1;
      else if (status in totals) totals[status] += 1;
    });
  }
  return {
    enrolled: roster.length - joinedLater,
    present: counted ? totals.present : null,
    late: counted ? totals.late : null,
    absent: counted ? totals.absent : null,
    not_scanned: counted ? totals.not_scanned : null,
  };
}

function describeSession(db, maps, session, roster, now) {
  return {
    session_id: session.session_id,
    class_id: session.class_id,
    class_label: maps.classes.get(session.class_id)?.class_label ?? session.class_id,
    session_date: session.session_date,
    start_time: session.actual_start || session.scheduled_start,
    end_time: session.actual_end || session.scheduled_end,
    room_code: maps.rooms.get(session.room_id)?.room_code ?? '',
    source: session.source,
    status: session.status,
    phase: sessionPhase(session, now),
    reason: session.override_reason || '',
    ...sessionCounts(db, session, roster, now),
  };
}

function ownClass(db, instructorId, classId) {
  const klass = db.Classes.find((row) => row.class_id === classId);
  if (!klass || klass.instructor_id !== instructorId) {
    throw new AppError('FORBIDDEN', 'This class is not assigned to you.');
  }
  return klass;
}

function classInfo(db, maps, klass) {
  const subject = maps.subjects.get(klass.subject_id);
  return {
    class_id: klass.class_id,
    class_label: klass.class_label,
    subject_code: subject?.subject_code ?? '',
    subject_title: subject?.subject_title ?? '',
    section_label: sectionLabel(maps, klass.section_id),
    instructor_name: fullName(maps.instructors.get(klass.instructor_id)),
    schedules: schedulesOf(db, maps, klass.class_id),
  };
}

/* ---------------- Instructor ---------------- */

function myClasses(db, instructorId) {
  return db.Classes
    .filter((row) => row.instructor_id === instructorId && row.status === 'active')
    .sort((a, b) => a.class_label.localeCompare(b.class_label));
}

function classSummary(db, maps, klass, now) {
  const roster = rosterIds(db, maps, klass.class_id);
  const sessions = countedSessions(db, klass.class_id);
  const statuses = [];
  sessions.forEach((session) => roster.forEach((studentId) => {
    const status = statusFor(db, session, studentId, now);
    if (status !== 'not_scanned') statuses.push(status);
  }));
  const totals = summarize(statuses);
  return {
    ...classInfo(db, maps, klass),
    enrolled: roster.length,
    sessions_held: heldCount(sessions, now),
    last_session_date: sessions.length ? sessions[sessions.length - 1].session_date : null,
    attendance_rate: totals.rate,
    totals,
  };
}

export function instructorDashboard(db, { date }, session, ctx) {
  if (!isValidDate(date)) throw new AppError('BAD_REQUEST', 'Please choose a valid date.');
  const instructorId = linkedId(db, session, 'instructor');
  const maps = lookups(db);
  const now = manilaAt(ctx.now());
  const instructor = maps.instructors.get(instructorId);
  const classes = myClasses(db, instructorId);
  const classIds = new Set(classes.map((row) => row.class_id));
  const activeTerm = db.Terms.find((term) => term.is_active === 'TRUE');
  const inTerm = Boolean(activeTerm) && date >= activeTerm.start_date && date <= activeTerm.end_date;

  // Sessions on the chosen date: every scheduled slot + manual sessions
  const dayCode = dayCodeOf(date);
  const sessions = [];
  if (inTerm) {
    db.Schedules
      .filter((row) => row.status === 'active' && row.day_of_week === dayCode && classIds.has(row.class_id))
      .forEach((slot) => {
        const roster = rosterIds(db, maps, slot.class_id);
        const held = db.ClassSessions.find((row) => row.schedule_id === slot.schedule_id && row.session_date === date);
        if (held) {
          sessions.push(describeSession(db, maps, held, roster, now));
          return;
        }
        let status;
        if (date > now.date || (date === now.date && now.time < slot.start_time)) status = 'scheduled';
        else if (date === now.date && now.time <= slot.end_time) status = 'in_progress';
        else status = 'no_record';
        sessions.push({
          session_id: null,
          class_id: slot.class_id,
          class_label: maps.classes.get(slot.class_id)?.class_label ?? slot.class_id,
          session_date: date,
          start_time: slot.start_time,
          end_time: slot.end_time,
          room_code: maps.rooms.get(slot.room_id)?.room_code ?? '',
          source: 'auto',
          status,
          phase: sessionPhase({ status: 'open', session_date: date, scheduled_start: slot.start_time, scheduled_end: slot.end_time }, now),
          reason: '',
          enrolled: roster.length,
          present: null,
          late: null,
          absent: null,
          not_scanned: null,
        });
      });
  }
  db.ClassSessions
    .filter((row) => row.source === 'manual' && row.session_date === date && classIds.has(row.class_id))
    .forEach((row) => sessions.push(describeSession(db, maps, row, rosterIds(db, maps, row.class_id), now)));
  sessions.sort((a, b) => a.start_time.localeCompare(b.start_time));

  const summaries = classes.map((klass) => classSummary(db, maps, klass, now));
  const all = summaries.reduce((acc, row) => ({
    present: acc.present + row.totals.present,
    late: acc.late + row.totals.late,
    total: acc.total + row.totals.total,
  }), { present: 0, late: 0, total: 0 });
  const uniqueStudents = new Set(classes.flatMap((klass) => rosterIds(db, maps, klass.class_id)));

  // Students who need follow-up: below 80% in any class with at least 2 sessions
  const watchlist = [];
  classes.forEach((klass) => {
    const held = countedSessions(db, klass.class_id);
    if (held.length < 2) return;
    rosterIds(db, maps, klass.class_id).forEach((studentId) => {
      const totals = summarize(held.map((s) => statusFor(db, s, studentId, now)).filter((s) => s !== 'not_scanned'));
      if (totals.rate !== null && totals.rate < 0.8) {
        const student = maps.students.get(studentId);
        watchlist.push({
          student_id: studentId,
          student_name: fullName(student),
          student_number: student?.student_number ?? '',
          class_id: klass.class_id,
          class_label: klass.class_label,
          ...totals,
        });
      }
    });
  });
  watchlist.sort((a, b) => a.rate - b.rate || b.absent - a.absent);

  return {
    date,
    today: now.date,
    in_term: inTerm,
    term_name: activeTerm?.term_name ?? null,
    instructor: { name: fullName(instructor), department: instructor?.department ?? '' },
    stats: {
      classes: classes.length,
      students: uniqueStudents.size,
      sessions_on_date: sessions.length,
      attendance_rate: rate(all.present, all.late, all.total),
    },
    sessions,
    classes: summaries,
    watchlist: watchlist.slice(0, 8),
  };
}

export function instructorListSessions(db, request, session, ctx) {
  const classId = request.class_id;
  const now = manilaAt(ctx.now());
  const instructorId = linkedId(db, session, 'instructor');
  const maps = lookups(db);
  const classes = myClasses(db, instructorId).map((klass) => ({ class_id: klass.class_id, class_label: klass.class_label }));
  if (!classId) return { classes, class: null, sessions: [] };
  const klass = ownClass(db, instructorId, classId);
  const range = dateRange(request);
  const roster = rosterIds(db, maps, classId);
  const sessions = db.ClassSessions
    .filter((row) => row.class_id === classId && range.has(row.session_date))
    .sort((a, b) => b.session_date.localeCompare(a.session_date) || b.scheduled_start.localeCompare(a.scheduled_start))
    .map((row) => describeSession(db, maps, row, roster, now));
  return { classes, class: { ...classInfo(db, maps, klass), enrolled: roster.length }, range: { from: range.from, to: range.to }, sessions };
}

export function instructorGetSession(db, { session_id: sessionId }, session, ctx) {
  const now = manilaAt(ctx.now());
  const instructorId = linkedId(db, session, 'instructor');
  const maps = lookups(db);
  const classSession = db.ClassSessions.find((row) => row.session_id === sessionId);
  if (!classSession) throw new AppError('NOT_FOUND', 'This class session was not found.');
  const klass = ownClass(db, instructorId, classSession.class_id);
  const roster = rosterIds(db, maps, klass.class_id);
  const corrections = correctionsFor(db, sessionId);

  const students = roster.filter((studentId) => statusFor(db, classSession, studentId, now) !== null).map((studentId) => {
    const student = maps.students.get(studentId);
    const record = recordOf(db, sessionId, studentId);
    const correction = corrections.get(correctionKey(sessionId, studentId));
    return {
      student_id: studentId,
      student_number: student?.student_number ?? '',
      first_name: student?.first_name ?? '',
      last_name: student?.last_name ?? '',
      status: classSession.status === 'cancelled' ? 'cancelled' : statusOf(record, classSession, now),
      scanned_at: record?.source === 'device' ? record.scanned_at : null,
      source: record?.source ?? null,
      sync_mode: record?.sync_mode ?? null,
      corrected: Boolean(correction),
      correction_reason: correction?.reason ?? '',
    };
  }).sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name));

  return {
    session: describeSession(db, maps, classSession, roster, now),
    class: classInfo(db, maps, klass),
    students,
  };
}

export function instructorCorrectAttendance(db, request, session, ctx) {
  const instructorId = linkedId(db, session, 'instructor');
  return correctAttendance(db, request, session, ctx, (classId) => {
    // Inactive (archived) classes are read-only for instructors; admins can still correct them.
    if (ownClass(db, instructorId, classId).status !== 'active') {
      throw new AppError('CLASS_INACTIVE', 'This class is inactive. Attendance can no longer be changed; ask the administrator.');
    }
  });
}

// Shared by instructor.correctAttendance and admin.correctAttendance (D6).
// checkClass(class_id) throws if this user may not correct the class; admins pass none.
export function correctAttendance(db, request, session, ctx, checkClass = () => {}) {
  const now = manilaAt(ctx.now());
  const maps = lookups(db);
  const sessionId = request.session_id;
  const studentId = request.student_id;
  const status = request.status;
  const reason = cleanText(request.reason);

  const classSession = db.ClassSessions.find((row) => row.session_id === sessionId);
  if (!classSession) throw new AppError('NOT_FOUND', 'This class session was not found.');
  checkClass(classSession.class_id);
  if (classSession.status === 'cancelled') {
    throw new AppError('SESSION_CANCELLED', 'Attendance cannot be changed for a cancelled class.');
  }
  if (sessionPhase(classSession, now) === 'upcoming') {
    throw new AppError('SESSION_NOT_STARTED', 'This class has not started yet. Correct attendance once it has started.');
  }
  if (!rosterIds(db, maps, classSession.class_id).includes(studentId)) {
    throw new AppError('NOT_ENROLLED', 'This student is not enrolled in the class.');
  }

  const fields = {};
  if (!CORRECTABLE.includes(status)) fields.status = 'Choose Present, Late, or Absent.';
  if (reason.length < 5) fields.reason = 'Give a short reason (at least 5 characters).';
  else if (reason.length > MAX_TEXT) fields.reason = `Use ${MAX_TEXT} characters or fewer.`;
  if (Object.keys(fields).length) throw validationError(fields);

  const record = recordOf(db, sessionId, studentId);
  // BUG-6: no row to override, so "absent" would change nothing; refuse instead of a fake success.
  if (!record && status === 'absent') {
    const message = 'This student has no tap for this session. They are counted as absent automatically when the class ends.';
    throw new AppError('VALIDATION_ERROR', message, { status: message });
  }
  const before = statusOf(record, classSession, now);
  if (before === status) throw validationError({ status: 'The student already has this status.' });

  // Never delete a row or edit the device fields (architecture 7.2 rule 4):
  // a retried scan_id must still find its row.
  if (record) {
    Object.assign(record, {
      override_status: status, override_by: session.user_id, override_at: now.iso, override_reason: reason,
    });
  } else {
    const student = maps.students.get(studentId);
    const card = db.RfidCards.find((row) => row.student_id === studentId && row.status === 'active');
    const stamp = `${classSession.session_date}T${classSession.scheduled_start}:00+08:00`;
    db.Attendance.push({
      attendance_id: nextId(db.Attendance, 'attendance_id', 'ATT', 5),
      session_id: sessionId,
      student_id: student.student_id,
      card_id: card?.card_id ?? '',
      rfid_uid: card?.rfid_uid ?? '',
      device_id: '',
      scan_id: '',
      scanned_at: stamp,
      received_at: now.iso,
      status,
      source: 'manual',
      sync_mode: '',
      time_quality: '',
      created_by: session.user_id,
      override_status: '',
      override_by: '',
      override_at: '',
      override_reason: reason,
    });
  }

  writeAudit(db, session, {
    action: CORRECTION_ACTION,
    entityType: 'Attendance',
    entityId: correctionKey(sessionId, studentId),
    before: { status: before },
    after: { status },
    reason,
  }, ctx);
  return { session_id: sessionId, student_id: studentId, status };
}

export function instructorClassReport(db, request, session, ctx) {
  const classId = request.class_id;
  const now = manilaAt(ctx.now());
  const instructorId = linkedId(db, session, 'instructor');
  const maps = lookups(db);
  const classes = myClasses(db, instructorId).map((klass) => ({ class_id: klass.class_id, class_label: klass.class_label }));
  if (!classId) return { classes, class: null };
  const klass = ownClass(db, instructorId, classId);
  const range = dateRange(request);

  const roster = rosterIds(db, maps, classId);
  const sessions = countedSessions(db, classId)
    .filter((row) => range.has(row.session_date));

  const students = roster.map((studentId) => {
    const student = maps.students.get(studentId);
    const marks = sessions.map((s) => statusFor(db, s, studentId, now));
    return {
      student_id: studentId,
      student_number: student?.student_number ?? '',
      first_name: student?.first_name ?? '',
      last_name: student?.last_name ?? '',
      marks,
      ...summarize(marks.filter((s) => s !== 'not_scanned')),
    };
  }).sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name));

  const totals = summarize(students.flatMap((row) => row.marks).filter((s) => s !== 'not_scanned'));
  const cancelled = db.ClassSessions.filter((row) => row.class_id === classId && row.status === 'cancelled'
    && range.has(row.session_date)).length;

  return {
    classes,
    class: { ...classInfo(db, maps, klass), enrolled: roster.length },
    range: { from: range.from, to: range.to },
    generated_at: now.iso,
    sessions: sessions.map((row) => describeSession(db, maps, row, roster, now)),
    cancelled_sessions: cancelled,
    students,
    totals,
  };
}

// Everyone enrolled in one of the instructor's classes, with their attendance
// so far. Works even before the first class session.
export function instructorClassRoster(db, request, session, ctx) {
  const classId = request.class_id;
  const now = manilaAt(ctx.now());
  const instructorId = linkedId(db, session, 'instructor');
  const maps = lookups(db);
  const klass = ownClass(db, instructorId, classId);
  const range = dateRange(request);
  const held = countedSessions(db, classId).filter((row) => range.has(row.session_date));
  const students = rosterIds(db, maps, classId).map((studentId) => {
    const student = maps.students.get(studentId);
    const totals = summarize(held.map((s) => statusFor(db, s, studentId, now)).filter((s) => s !== 'not_scanned'));
    const card = db.RfidCards.find((row) => row.student_id === studentId && row.status === 'active');
    return {
      student_id: studentId,
      student_number: student?.student_number ?? '',
      first_name: student?.first_name ?? '',
      last_name: student?.last_name ?? '',
      section_label: sectionLabel(maps, student?.section_id),
      other_section: student?.section_id !== klass.section_id,
      has_card: Boolean(card),
      ...totals,
    };
  }).sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name));
  return {
    class: { ...classInfo(db, maps, klass), enrolled: students.length, sessions_held: heldCount(held, now) },
    range: { from: range.from, to: range.to },
    students,
  };
}

export function instructorStudentHistory(db, request, session, ctx) {
  const { class_id: classId, student_id: studentId } = request;
  const now = manilaAt(ctx.now());
  const instructorId = linkedId(db, session, 'instructor');
  const maps = lookups(db);
  const klass = ownClass(db, instructorId, classId);
  if (!rosterIds(db, maps, classId).includes(studentId)) {
    throw new AppError('NOT_ENROLLED', 'This student is not enrolled in the class.');
  }
  const range = dateRange(request);
  const student = maps.students.get(studentId);
  const records = historyRows(db, maps, studentId, [klass], now, range);
  return {
    student: {
      student_id: studentId,
      name: fullName(student),
      student_number: student?.student_number ?? '',
      section_label: sectionLabel(maps, student?.section_id),
    },
    class: classInfo(db, maps, klass),
    range: { from: range.from, to: range.to },
    records,
    totals: summarize(records.map((row) => row.status).filter((s) => s !== 'not_scanned' && s !== 'cancelled')),
  };
}

const RECENT_DEFAULT = 20;
const RECENT_MAX = 50;

// D12: the latest attendance rows (taps and corrections) of the instructor's own
// classes, newest first. Optional class_id (own class, any status); limit 1-50.
export function instructorRecentActivity(db, request, session) {
  const instructorId = linkedId(db, session, 'instructor');
  const classes = request.class_id ? [ownClass(db, instructorId, request.class_id)] : myClasses(db, instructorId);
  let limit = RECENT_DEFAULT;
  if (request.limit !== undefined && request.limit !== null && request.limit !== '') {
    limit = Number(request.limit);
    if (!Number.isInteger(limit) || limit < 1) throw validationError({ limit: 'Enter a whole number of 1 or more.' });
    limit = Math.min(limit, RECENT_MAX);
  }
  const students = indexBy(db.Students, 'student_id');
  const classIds = new Set(classes.map((klass) => klass.class_id));
  const sessions = new Map(db.ClassSessions.filter((row) => classIds.has(row.class_id)).map((row) => [row.session_id, row]));
  const rows = db.Attendance
    .filter((row) => sessions.has(row.session_id))
    .sort((a, b) => String(b.scanned_at).localeCompare(String(a.scanned_at)) || String(b.attendance_id).localeCompare(String(a.attendance_id)));
  const items = rows.slice(0, limit).map((row) => {
    const classSession = sessions.get(row.session_id);
    const student = students.get(row.student_id);
    return {
      attendance_id: row.attendance_id,
      session_id: row.session_id,
      session_date: classSession.session_date,
      class_id: classSession.class_id,
      class_label: classes.find((klass) => klass.class_id === classSession.class_id).class_label,
      student_id: row.student_id,
      student_number: student?.student_number ?? '',
      student_name: fullName(student),
      scanned_at: row.scanned_at,
      status: effectiveStatus(row),
      source: row.source,
      sync_mode: row.sync_mode || '',
      corrected: Boolean(row.override_status || row.override_reason),
    };
  });
  return { limit, has_more: rows.length > limit, items };
}

/* ---------------- Student ---------------- */

function myEnrolledClasses(db, studentId) {
  const ids = new Set(db.Enrollments.filter((row) => row.student_id === studentId && row.status === 'enrolled').map((row) => row.class_id));
  return db.Classes.filter((row) => ids.has(row.class_id) && row.status === 'active')
    .sort((a, b) => a.class_label.localeCompare(b.class_label));
}

function historyRows(db, maps, studentId, classes, now, range) {
  const corrections = new Set(db.Attendance
    .filter((row) => row.student_id === studentId && row.override_reason)
    .map((row) => correctionKey(row.session_id, row.student_id)));

  return classes.flatMap((klass) => db.ClassSessions
    .filter((row) => row.class_id === klass.class_id && range.has(row.session_date)
      && statusFor(db, row, studentId, now) !== null)
    .map((row) => {
      const record = recordOf(db, row.session_id, studentId);
      const subject = maps.subjects.get(klass.subject_id);
      return {
        session_id: row.session_id,
        class_id: klass.class_id,
        class_label: klass.class_label,
        subject_code: subject?.subject_code ?? '',
        subject_title: subject?.subject_title ?? '',
        session_date: row.session_date,
        start_time: row.actual_start || row.scheduled_start,
        end_time: row.actual_end || row.scheduled_end,
        room_code: maps.rooms.get(row.room_id)?.room_code ?? '',
        status: row.status === 'cancelled' ? 'cancelled' : statusOf(record, row, now),
        scanned_at: record?.source === 'device' ? record.scanned_at : null,
        manual: record?.source === 'manual',
        corrected: corrections.has(correctionKey(row.session_id, studentId)),
      };
    }))
    .sort((a, b) => b.session_date.localeCompare(a.session_date) || b.start_time.localeCompare(a.start_time));
}

function studentProfile(db, maps, studentId) {
  const student = maps.students.get(studentId);
  if (!student) throw new AppError('NOT_FOUND', 'Your student record was not found. Contact the administrator.');
  const section = maps.sections.get(student.section_id);
  const program = maps.programs.get(student.program_id);
  const card = db.RfidCards.find((row) => row.student_id === studentId && row.status === 'active');
  return {
    name: fullName(student),
    first_name: student.first_name,
    last_name: student.last_name,
    student_number: student.student_number,
    email: student.email,
    program_code: program?.program_code ?? '',
    program_name: program?.program_name ?? '',
    year_level: student.year_level,
    section_label: sectionLabel(maps, student.section_id),
    section_name: section?.section_name ?? '',
    account_status: student.account_status,
    card: card ? { rfid_uid_masked: `•••• ${card.rfid_uid.slice(-4)}`, assigned_at: card.assigned_at } : null,
  };
}

export function studentOverview(db, request, session, ctx) {
  const now = manilaAt(ctx.now());
  const studentId = linkedId(db, session, 'student');
  const range = dateRange(request);
  const maps = lookups(db);
  const classes = myEnrolledClasses(db, studentId);
  const records = historyRows(db, maps, studentId, classes, now, range);
  const counted = (rows) => rows.map((row) => row.status).filter((s) => s !== 'not_scanned' && s !== 'cancelled');

  const subjects = classes.map((klass) => {
    const rows = records.filter((row) => row.class_id === klass.class_id);
    return {
      ...classInfo(db, maps, klass),
      ...summarize(counted(rows)),
      last: rows.find((row) => row.status !== 'cancelled') ?? null,
    };
  });

  const activeTerm = db.Terms.find((term) => term.is_active === 'TRUE');
  const todayCode = dayCodeOf(now.date);
  const today = classes.flatMap((klass) => schedulesOf(db, maps, klass.class_id)
    .filter((slot) => slot.day === todayCode)
    .map((slot) => ({ ...slot, class_label: klass.class_label, subject_title: maps.subjects.get(klass.subject_id)?.subject_title ?? '' })))
    .sort((a, b) => a.start_time.localeCompare(b.start_time));

  return {
    profile: studentProfile(db, maps, studentId),
    term_name: activeTerm?.term_name ?? null,
    today_date: now.date,
    today,
    range: { from: range.from, to: range.to },
    totals: summarize(counted(records)),
    subjects,
    recent: records.filter((row) => row.status !== 'cancelled').slice(0, 6),
  };
}

export function studentHistory(db, request, session, ctx) {
  const classId = request.class_id || '';
  const now = manilaAt(ctx.now());
  const studentId = linkedId(db, session, 'student');
  const maps = lookups(db);
  const classes = myEnrolledClasses(db, studentId);
  const chosen = classId ? classes.filter((row) => row.class_id === classId) : classes;
  if (classId && !chosen.length) throw new AppError('FORBIDDEN', 'You are not enrolled in this class.');
  const range = dateRange(request);
  const records = historyRows(db, maps, studentId, chosen, now, range);
  return {
    classes: classes.map((klass) => ({
      class_id: klass.class_id,
      class_label: klass.class_label,
      subject_title: maps.subjects.get(klass.subject_id)?.subject_title ?? '',
    })),
    range: { from: range.from, to: range.to },
    records,
    totals: summarize(records.map((row) => row.status).filter((s) => s !== 'not_scanned' && s !== 'cancelled')),
  };
}

export function studentGetProfile(db, _request, session) {
  const studentId = linkedId(db, session, 'student');
  const maps = lookups(db);
  const user = db.Users.find((row) => row.user_id === session.user_id);
  return {
    profile: studentProfile(db, maps, studentId),
    account: { username: user?.username ?? '', email: user?.email ?? '', last_login_at: user?.last_login_at || null },
    classes: myEnrolledClasses(db, studentId).map((klass) => classInfo(db, maps, klass)),
  };
}
