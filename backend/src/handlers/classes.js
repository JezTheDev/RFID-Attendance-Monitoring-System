// Admin: classes (subject + section + instructor), their weekly schedules,
// and which students are enrolled. The Instructor and Student portals and the
// RFID session lookup all read from these three tables.
import {
  AppError, validationError, manilaNow, indexBy, fullName, cleanText, writeAudit, nextId,
} from '../utils.js';

const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function maps(db) {
  return {
    subjects: indexBy(db.Subjects, 'subject_id'),
    sections: indexBy(db.Sections, 'section_id'),
    programs: indexBy(db.Programs, 'program_id'),
    instructors: indexBy(db.Instructors, 'instructor_id'),
    rooms: indexBy(db.Rooms, 'room_id'),
    students: indexBy(db.Students, 'student_id'),
    terms: indexBy(db.Terms, 'term_id'),
  };
}

function sectionLabel(m, sectionId) {
  const section = m.sections.get(sectionId);
  if (!section) return '';
  return `${m.programs.get(section.program_id)?.program_code ?? ''} ${section.section_name}`.trim();
}

function findClass(db, classId) {
  const klass = db.Classes.find((row) => row.class_id === classId);
  if (!klass) throw new AppError('NOT_FOUND', 'Class not found.');
  return klass;
}

function activeSchedules(db, classId) {
  return db.Schedules
    .filter((row) => row.class_id === classId && row.status === 'active')
    .sort((a, b) => DAYS.indexOf(a.day_of_week) - DAYS.indexOf(b.day_of_week) || a.start_time.localeCompare(b.start_time));
}

function enrolledIds(db, classId) {
  return db.Enrollments.filter((row) => row.class_id === classId && row.status === 'enrolled').map((row) => row.student_id);
}

function scheduleView(m, row) {
  return {
    schedule_id: row.schedule_id,
    day: row.day_of_week,
    start_time: row.start_time,
    end_time: row.end_time,
    room_id: row.room_id,
    room_code: m.rooms.get(row.room_id)?.room_code ?? '',
  };
}

function classRow(db, m, klass) {
  const subject = m.subjects.get(klass.subject_id);
  return {
    class_id: klass.class_id,
    class_label: klass.class_label,
    term_id: klass.term_id,
    term_name: m.terms.get(klass.term_id)?.term_name ?? '',
    subject_id: klass.subject_id,
    subject_code: subject?.subject_code ?? '',
    subject_title: subject?.subject_title ?? '',
    section_id: klass.section_id,
    section_label: sectionLabel(m, klass.section_id),
    instructor_id: klass.instructor_id,
    instructor_name: fullName(m.instructors.get(klass.instructor_id)),
    late_grace_minutes: klass.late_grace_minutes,
    status: klass.status,
    enrolled: enrolledIds(db, klass.class_id).filter((id) => m.students.get(id)?.account_status === 'active').length,
    schedules: activeSchedules(db, klass.class_id).map((row) => scheduleView(m, row)),
  };
}

/* ---------------- read ---------------- */

export function getClassOptions(db) {
  const m = maps(db);
  return {
    terms: [...db.Terms].sort((a, b) => b.start_date.localeCompare(a.start_date))
      .map((row) => ({ value: row.term_id, label: row.term_name + (row.is_active === 'TRUE' ? ' (active)' : ''), active: row.is_active === 'TRUE' })),
    subjects: db.Subjects.filter((row) => row.status === 'active')
      .sort((a, b) => a.subject_code.localeCompare(b.subject_code))
      .map((row) => ({ value: row.subject_id, label: `${row.subject_code} — ${row.subject_title}` })),
    sections: db.Sections.filter((row) => row.status === 'active')
      .map((row) => ({ value: row.section_id, label: sectionLabel(m, row.section_id) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    instructors: db.Instructors.filter((row) => row.account_status === 'active')
      .sort((a, b) => a.last_name.localeCompare(b.last_name))
      .map((row) => ({ value: row.instructor_id, label: `${row.last_name}, ${row.first_name}` })),
    rooms: db.Rooms.filter((row) => row.status === 'active')
      .sort((a, b) => a.room_code.localeCompare(b.room_code))
      .map((row) => ({ value: row.room_id, label: `${row.room_code} — ${row.room_name}` })),
  };
}

export function listClasses(db, { term_id: termId = '' } = {}) {
  const m = maps(db);
  const activeTerm = db.Terms.find((row) => row.is_active === 'TRUE');
  const chosen = termId || activeTerm?.term_id || '';
  return {
    term_id: chosen,
    items: db.Classes
      .filter((row) => !chosen || row.term_id === chosen)
      .map((row) => classRow(db, m, row))
      .sort((a, b) => a.class_label.localeCompare(b.class_label)),
  };
}

export function getClass(db, { class_id: classId }) {
  const m = maps(db);
  const klass = findClass(db, classId);
  const enrolled = new Set(enrolledIds(db, classId));
  const toStudent = (student) => ({
    student_id: student.student_id,
    student_number: student.student_number,
    name: `${student.last_name}, ${student.first_name}`,
    section_id: student.section_id,
    section_label: sectionLabel(m, student.section_id),
    account_status: student.account_status,
  });
  const byName = (a, b) => a.name.localeCompare(b.name);
  return {
    class: classRow(db, m, klass),
    students: db.Students.filter((row) => enrolled.has(row.student_id)).map(toStudent).sort(byName),
    // Active students who could still be added (same section first)
    candidates: db.Students
      .filter((row) => row.account_status === 'active' && !enrolled.has(row.student_id))
      .map(toStudent)
      .sort((a, b) => Number(b.section_id === klass.section_id) - Number(a.section_id === klass.section_id) || byName(a, b)),
  };
}

/* ---------------- classes ---------------- */

function graceValue(errors, value) {
  const text = cleanText(value);
  if (text === '') return '';
  const number = Number(text);
  if (!Number.isInteger(number) || number < 0 || number > 60) {
    errors.late_grace_minutes = 'Enter whole minutes from 0 to 60, or leave blank to use the default.';
  }
  return String(number);
}

export function createClass(db, input, session) {
  const m = maps(db);
  const errors = {};
  const value = {
    term_id: cleanText(input.term_id),
    subject_id: cleanText(input.subject_id),
    section_id: cleanText(input.section_id),
    instructor_id: cleanText(input.instructor_id),
  };
  const lateGrace = graceValue(errors, input.late_grace_minutes);
  if (!m.terms.has(value.term_id)) errors.term_id = 'Choose a term.';
  if (m.subjects.get(value.subject_id)?.status !== 'active') errors.subject_id = 'Choose an active subject.';
  if (m.sections.get(value.section_id)?.status !== 'active') errors.section_id = 'Choose an active section.';
  if (m.instructors.get(value.instructor_id)?.account_status !== 'active') errors.instructor_id = 'Choose an active instructor.';
  if (!errors.subject_id && !errors.section_id && db.Classes.some((row) => row.term_id === value.term_id
    && row.subject_id === value.subject_id && row.section_id === value.section_id && row.status === 'active')) {
    errors.section_id = 'This section already has an active class for this subject in this term.';
  }
  if (Object.keys(errors).length) throw validationError(errors);

  const klass = {
    class_id: nextId(db.Classes, 'class_id', 'CLS'),
    term_id: value.term_id,
    subject_id: value.subject_id,
    section_id: value.section_id,
    instructor_id: value.instructor_id,
    class_label: `${m.subjects.get(value.subject_id).subject_code} - ${m.sections.get(value.section_id).section_name}`,
    late_grace_minutes: lateGrace,
    status: 'active',
  };
  db.Classes.push(klass);

  // Default: the whole section is enrolled. The admin can adjust afterwards.
  const sectionStudents = db.Students.filter((row) => row.section_id === value.section_id && row.account_status === 'active');
  sectionStudents.forEach((student) => enroll(db, klass.class_id, student.student_id));

  writeAudit(db, session, { action: 'CLASS_CREATE', entityType: 'Classes', entityId: klass.class_id, after: { ...klass, enrolled: sectionStudents.length } });
  return { class_id: klass.class_id, class_label: klass.class_label, enrolled: sectionStudents.length };
}

export function updateClass(db, input, session) {
  const m = maps(db);
  const klass = findClass(db, input.class_id);
  const errors = {};
  const instructorId = cleanText(input.instructor_id);
  const lateGrace = graceValue(errors, input.late_grace_minutes);
  if (m.instructors.get(instructorId)?.account_status !== 'active') errors.instructor_id = 'Choose an active instructor.';
  if (!errors.instructor_id && instructorId !== klass.instructor_id) {
    const clash = scheduleClash(db, m, {
      classId: klass.class_id, termId: klass.term_id, instructorId, sectionId: '', roomId: '',
      slots: activeSchedules(db, klass.class_id),
    });
    if (clash) errors.instructor_id = clash;
  }
  if (Object.keys(errors).length) throw validationError(errors);

  const before = { instructor_id: klass.instructor_id, late_grace_minutes: klass.late_grace_minutes };
  klass.instructor_id = instructorId;
  klass.late_grace_minutes = lateGrace;
  writeAudit(db, session, { action: 'CLASS_UPDATE', entityType: 'Classes', entityId: klass.class_id, before, after: { instructor_id: instructorId, late_grace_minutes: lateGrace } });
  return { class_id: klass.class_id };
}

export function setClassStatus(db, { class_id: classId, status }, session) {
  const klass = findClass(db, classId);
  if (!['active', 'inactive'].includes(status)) throw new AppError('BAD_REQUEST', 'Invalid status.');
  if (klass.status === status) throw new AppError('NO_CHANGE', `This class is already ${status}.`);
  if (status === 'active') {
    if (db.Classes.some((row) => row.class_id !== classId && row.term_id === klass.term_id && row.subject_id === klass.subject_id
      && row.section_id === klass.section_id && row.status === 'active')) {
      throw new AppError('IN_USE', 'Another active class already covers this subject and section.');
    }
  }
  const before = { status: klass.status };
  klass.status = status;
  writeAudit(db, session, { action: status === 'active' ? 'CLASS_ACTIVATE' : 'CLASS_DEACTIVATE', entityType: 'Classes', entityId: classId, before, after: { status } });
  return { class_id: classId, status };
}

/* ---------------- schedules ---------------- */

function overlaps(a, b) {
  return a.day_of_week === b.day_of_week && a.start_time < b.end_time && b.start_time < a.end_time;
}

// Returns a message if the room, the instructor or the section is already busy.
function scheduleClash(db, m, { classId, termId, instructorId, sectionId, roomId, slots, ignoreScheduleId = '' }) {
  const otherClasses = new Map(db.Classes
    .filter((row) => row.class_id !== classId && row.term_id === termId && row.status === 'active')
    .map((row) => [row.class_id, row]));
  for (const slot of slots) {
    for (const other of db.Schedules) {
      if (other.status !== 'active' || other.schedule_id === ignoreScheduleId || !overlaps(slot, other)) continue;
      const otherClass = otherClasses.get(other.class_id);
      if (!otherClass) continue;
      const when = `${other.day_of_week} ${other.start_time}–${other.end_time}`;
      if (roomId && other.room_id === roomId) return `${m.rooms.get(roomId)?.room_code ?? 'This room'} is already used by ${otherClass.class_label} on ${when}.`;
      if (instructorId && otherClass.instructor_id === instructorId) return `${fullName(m.instructors.get(instructorId))} already teaches ${otherClass.class_label} on ${when}.`;
      if (sectionId && otherClass.section_id === sectionId) return `This section already has ${otherClass.class_label} on ${when}.`;
    }
  }
  return '';
}

export function addSchedule(db, input, session) {
  const m = maps(db);
  const klass = findClass(db, input.class_id);
  if (klass.status !== 'active') throw new AppError('CLASS_INACTIVE', 'Activate this class before adding a schedule.');
  const errors = {};
  const slot = {
    day_of_week: cleanText(input.day_of_week).toUpperCase(),
    start_time: cleanText(input.start_time).slice(0, 5),
    end_time: cleanText(input.end_time).slice(0, 5),
    room_id: cleanText(input.room_id),
  };
  if (!DAYS.includes(slot.day_of_week)) errors.day_of_week = 'Choose a day.';
  if (!TIME_PATTERN.test(slot.start_time)) errors.start_time = 'Enter a start time.';
  if (!TIME_PATTERN.test(slot.end_time)) errors.end_time = 'Enter an end time.';
  if (!errors.start_time && !errors.end_time && slot.end_time <= slot.start_time) errors.end_time = 'End time must be after the start time.';
  if (m.rooms.get(slot.room_id)?.status !== 'active') errors.room_id = 'Choose an active room.';
  if (!Object.keys(errors).length) {
    const own = activeSchedules(db, klass.class_id).find((row) => overlaps(row, slot));
    if (own) errors.start_time = `This class already meets on ${own.day_of_week} ${own.start_time}–${own.end_time}.`;
  }
  if (!Object.keys(errors).length) {
    const clash = scheduleClash(db, m, {
      classId: klass.class_id, termId: klass.term_id, instructorId: klass.instructor_id,
      sectionId: klass.section_id, roomId: slot.room_id, slots: [slot],
    });
    if (clash) errors.start_time = clash;
  }
  if (Object.keys(errors).length) throw validationError(errors);

  const row = { schedule_id: nextId(db.Schedules, 'schedule_id', 'SCH'), class_id: klass.class_id, ...slot, status: 'active' };
  db.Schedules.push(row);
  writeAudit(db, session, { action: 'SCHEDULE_CREATE', entityType: 'Schedules', entityId: row.schedule_id, after: row });
  return { schedule_id: row.schedule_id };
}

export function removeSchedule(db, { schedule_id: scheduleId }, session) {
  const row = db.Schedules.find((item) => item.schedule_id === scheduleId);
  if (!row || row.status !== 'active') throw new AppError('NOT_FOUND', 'Schedule not found.');
  // Kept as "inactive" so past sessions still point to a real schedule.
  row.status = 'inactive';
  writeAudit(db, session, { action: 'SCHEDULE_REMOVE', entityType: 'Schedules', entityId: scheduleId, before: { status: 'active' }, after: { status: 'inactive' } });
  return { schedule_id: scheduleId };
}

/* ---------------- enrollments ---------------- */

function enroll(db, classId, studentId) {
  const existing = db.Enrollments.find((row) => row.class_id === classId && row.student_id === studentId);
  if (existing) {
    if (existing.status === 'enrolled') return false;
    existing.status = 'enrolled';
    return true;
  }
  db.Enrollments.push({
    enrollment_id: nextId(db.Enrollments, 'enrollment_id', 'ENR'),
    class_id: classId,
    student_id: studentId,
    status: 'enrolled',
    enrolled_at: manilaNow().iso,
  });
  return true;
}

export function enrollStudents(db, input, session) {
  const klass = findClass(db, input.class_id);
  const m = maps(db);
  let ids = Array.isArray(input.student_ids) ? input.student_ids : String(input.student_ids ?? '').split(',');
  ids = ids.map(cleanText).filter(Boolean);
  if (input.section_id) {
    ids = ids.concat(db.Students.filter((row) => row.section_id === input.section_id && row.account_status === 'active').map((row) => row.student_id));
  }
  if (!ids.length) throw validationError({ student_ids: 'Choose at least one student.' });
  const invalid = ids.find((id) => m.students.get(id)?.account_status !== 'active');
  if (invalid) throw validationError({ student_ids: 'Only active students can be enrolled.' });

  const added = [...new Set(ids)].filter((id) => enroll(db, klass.class_id, id));
  if (added.length) {
    writeAudit(db, session, { action: 'ENROLL_ADD', entityType: 'Enrollments', entityId: klass.class_id, after: { student_ids: added } });
  }
  return { class_id: klass.class_id, added: added.length };
}

export function dropEnrollment(db, { class_id: classId, student_id: studentId, reason = '' }, session) {
  findClass(db, classId);
  const row = db.Enrollments.find((item) => item.class_id === classId && item.student_id === studentId && item.status === 'enrolled');
  if (!row) throw new AppError('NOT_FOUND', 'This student is not enrolled in the class.');
  const cleanReason = cleanText(reason);
  if (cleanReason.length < 3) throw validationError({ reason: 'Please give a short reason.' });
  row.status = 'dropped';
  writeAudit(db, session, {
    action: 'ENROLL_DROP', entityType: 'Enrollments', entityId: row.enrollment_id,
    before: { status: 'enrolled' }, after: { status: 'dropped' }, reason: cleanReason,
  });
  return { class_id: classId, student_id: studentId };
}

// Used when a new student is added: join every active class of their section
// in the active term, so they show up in their instructors' rosters at once.
export function enrollInSectionClasses(db, studentId, sectionId) {
  const activeTerm = db.Terms.find((row) => row.is_active === 'TRUE');
  return db.Classes
    .filter((row) => row.section_id === sectionId && row.status === 'active' && (!activeTerm || row.term_id === activeTerm.term_id))
    .filter((row) => enroll(db, row.class_id, studentId)).length;
}
