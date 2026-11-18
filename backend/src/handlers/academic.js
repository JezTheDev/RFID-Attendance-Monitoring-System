import { AppError, validationError, isValidDate, cleanText, writeAudit, nextId } from '../utils.js';

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]*$/;
const ROOM_CODE_PATTERN = /^[A-Za-z0-9-]+$/;
const STATUSES = ['active', 'inactive'];

function text(errors, value, field, { required = true, max = 80, pattern = null, patternMessage = '' } = {}) {
  const clean = cleanText(value);
  if (!clean) {
    if (required) errors[field] = 'This field is required.';
  } else if (clean.length > max) {
    errors[field] = `Use ${max} characters or fewer.`;
  } else if (pattern && !pattern.test(clean)) {
    errors[field] = patternMessage;
  }
  return clean;
}

function integer(errors, value, field, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    errors[field] = `Enter a whole number from ${min} to ${max}.`;
  }
  return number;
}

function find(rows, key, id, label) {
  const row = rows.find((item) => item[key] === id);
  if (!row) throw new AppError('NOT_FOUND', `${label} not found.`);
  return row;
}

function failIfErrors(errors) {
  if (Object.keys(errors).length) throw validationError(errors);
}

function changeStatus(db, session, { rows, key, id, status, label, entityType, blockers }) {
  if (!STATUSES.includes(status)) throw new AppError('BAD_REQUEST', 'Invalid status.');
  const row = find(rows, key, id, label);
  if (row.status === status) throw new AppError('NO_CHANGE', `This ${label.toLowerCase()} is already ${status}.`);
  if (status === 'inactive') {
    const reasons = blockers(row).filter(Boolean);
    if (reasons.length) throw new AppError('IN_USE', `This ${label.toLowerCase()} cannot be deactivated yet: ${reasons.join('; ')}.`);
  }
  const before = { status: row.status };
  row.status = status;
  writeAudit(db, session, {
    action: `${entityType.toUpperCase()}_${status === 'active' ? 'ACTIVATE' : 'DEACTIVATE'}`,
    entityType, entityId: id, before, after: { status },
  });
  return { [key]: id, status };
}

function countLabel(count, singular, plural = `${singular}s`) {
  return count ? `${count} ${count === 1 ? singular : plural}` : '';
}

function programLabel(db, programId) {
  return db.Programs.find((row) => row.program_id === programId)?.program_code ?? '';
}

// ---------- Terms ----------

export function listTerms(db) {
  return {
    items: [...db.Terms]
      .sort((a, b) => b.start_date.localeCompare(a.start_date))
      .map((row) => ({
        ...row,
        is_active: row.is_active === 'TRUE',
        class_count: db.Classes.filter((klass) => klass.term_id === row.term_id).length,
      })),
  };
}

function validateTerm(db, input, existing = null) {
  const errors = {};
  const value = {
    term_name: text(errors, input.term_name, 'term_name', { max: 80 }),
    start_date: cleanText(input.start_date),
    end_date: cleanText(input.end_date),
  };
  if (!isValidDate(value.start_date)) errors.start_date = 'Enter a valid start date.';
  if (!isValidDate(value.end_date)) errors.end_date = 'Enter a valid end date.';
  if (!errors.start_date && !errors.end_date && value.end_date <= value.start_date) {
    errors.end_date = 'End date must be after the start date.';
  }
  if (!errors.term_name && db.Terms.some((row) => row.term_name.toLowerCase() === value.term_name.toLowerCase() && row.term_id !== existing?.term_id)) {
    errors.term_name = 'Another term already has this name.';
  }
  if (!errors.start_date && !errors.end_date) {
    const overlap = db.Terms.find((row) => row.term_id !== existing?.term_id
      && value.start_date <= row.end_date && value.end_date >= row.start_date);
    if (overlap) errors.start_date = `These dates overlap with "${overlap.term_name}".`;
  }
  if (existing && !errors.start_date && !errors.end_date) {
    const outside = db.ClassSessions.some((session) => db.Classes.some((klass) => klass.class_id === session.class_id && klass.term_id === existing.term_id)
      && (session.session_date < value.start_date || session.session_date > value.end_date));
    if (outside) errors.end_date = 'Recorded class sessions would fall outside these dates.';
  }
  failIfErrors(errors);
  return value;
}

export function createTerm(db, input, session) {
  const value = validateTerm(db, input);
  const row = { term_id: nextId(db.Terms, 'term_id', 'TRM'), ...value, is_active: 'FALSE' };
  db.Terms.push(row);
  writeAudit(db, session, { action: 'TERM_CREATE', entityType: 'Terms', entityId: row.term_id, after: row });
  return { term_id: row.term_id };
}

export function updateTerm(db, input, session) {
  const row = find(db.Terms, 'term_id', input.term_id, 'Term');
  const value = validateTerm(db, input, row);
  const before = { ...row };
  Object.assign(row, value);
  writeAudit(db, session, { action: 'TERM_UPDATE', entityType: 'Terms', entityId: row.term_id, before, after: { ...row } });
  return { term_id: row.term_id };
}

export function setActiveTerm(db, { term_id }, session) {
  const row = find(db.Terms, 'term_id', term_id, 'Term');
  if (row.is_active === 'TRUE') throw new AppError('NO_CHANGE', 'This term is already the active term.');
  const previous = db.Terms.find((item) => item.is_active === 'TRUE');
  db.Terms.forEach((item) => { item.is_active = item.term_id === term_id ? 'TRUE' : 'FALSE'; });
  writeAudit(db, session, {
    action: 'TERM_SET_ACTIVE', entityType: 'Terms', entityId: term_id,
    before: { active_term: previous?.term_id ?? null }, after: { active_term: term_id },
  });
  return { term_id };
}

// ---------- Programs ----------

export function listPrograms(db) {
  return {
    items: [...db.Programs]
      .sort((a, b) => a.program_code.localeCompare(b.program_code))
      .map((row) => ({
        ...row,
        section_count: db.Sections.filter((s) => s.program_id === row.program_id && s.status === 'active').length,
        student_count: db.Students.filter((s) => s.program_id === row.program_id && s.account_status === 'active').length,
      })),
  };
}

function validateProgram(db, input, existing = null) {
  const errors = {};
  const value = {
    program_code: text(errors, input.program_code, 'program_code', { max: 20, pattern: CODE_PATTERN, patternMessage: 'Use letters, numbers, spaces, or hyphens.' }),
    program_name: text(errors, input.program_name, 'program_name', { max: 120 }),
  };
  if (!errors.program_code && db.Programs.some((row) => row.program_code.toLowerCase() === value.program_code.toLowerCase() && row.program_id !== existing?.program_id)) {
    errors.program_code = 'Another program already uses this code.';
  }
  failIfErrors(errors);
  return value;
}

export function createProgram(db, input, session) {
  const value = validateProgram(db, input);
  const row = { program_id: nextId(db.Programs, 'program_id', 'PRG'), ...value, status: 'active' };
  db.Programs.push(row);
  writeAudit(db, session, { action: 'PROGRAM_CREATE', entityType: 'Programs', entityId: row.program_id, after: row });
  return { program_id: row.program_id };
}

export function updateProgram(db, input, session) {
  const row = find(db.Programs, 'program_id', input.program_id, 'Program');
  const value = validateProgram(db, input, row);
  const before = { ...row };
  Object.assign(row, value);
  writeAudit(db, session, { action: 'PROGRAM_UPDATE', entityType: 'Programs', entityId: row.program_id, before, after: { ...row } });
  return { program_id: row.program_id };
}

export function setProgramStatus(db, { program_id, status }, session) {
  return changeStatus(db, session, {
    rows: db.Programs, key: 'program_id', id: program_id, status, label: 'Program', entityType: 'Programs',
    blockers: (row) => [
      countLabel(db.Sections.filter((s) => s.program_id === row.program_id && s.status === 'active').length, 'active section'),
      countLabel(db.Students.filter((s) => s.program_id === row.program_id && s.account_status === 'active').length, 'active student'),
    ],
  });
}

// ---------- Sections ----------

export function listSections(db) {
  return {
    items: [...db.Sections]
      .map((row) => ({
        ...row,
        year_level: Number(row.year_level),
        program_code: programLabel(db, row.program_id),
        label: `${programLabel(db, row.program_id)} ${row.section_name}`.trim(),
        student_count: db.Students.filter((s) => s.section_id === row.section_id && s.account_status === 'active').length,
        class_count: db.Classes.filter((c) => c.section_id === row.section_id && c.status === 'active').length,
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    programs: db.Programs.filter((row) => row.status === 'active').map((row) => ({ value: row.program_id, label: `${row.program_code} — ${row.program_name}` })),
  };
}

function validateSection(db, input, existing = null) {
  const errors = {};
  const value = {
    program_id: cleanText(input.program_id),
    year_level: integer(errors, input.year_level, 'year_level', 1, 5),
    section_name: text(errors, input.section_name, 'section_name', { max: 20, pattern: CODE_PATTERN, patternMessage: 'Use letters, numbers, spaces, or hyphens.' }).toUpperCase(),
  };
  if (!db.Programs.some((row) => row.program_id === value.program_id && row.status === 'active')) errors.program_id = 'Choose an active program.';
  if (!errors.section_name && !errors.program_id && db.Sections.some((row) => row.program_id === value.program_id
    && row.section_name.toLowerCase() === value.section_name.toLowerCase() && row.section_id !== existing?.section_id)) {
    errors.section_name = 'This program already has a section with this name.';
  }
  if (existing && !errors.program_id && !errors.year_level
    && (value.program_id !== existing.program_id || String(value.year_level) !== String(existing.year_level))
    && db.Students.some((s) => s.section_id === existing.section_id && s.account_status === 'active')) {
    errors.program_id = 'Program and year level cannot change while active students belong to this section.';
  }
  failIfErrors(errors);
  return { ...value, year_level: String(value.year_level) };
}

export function createSection(db, input, session) {
  const value = validateSection(db, input);
  const row = { section_id: nextId(db.Sections, 'section_id', 'SEC'), ...value, status: 'active' };
  db.Sections.push(row);
  writeAudit(db, session, { action: 'SECTION_CREATE', entityType: 'Sections', entityId: row.section_id, after: row });
  return { section_id: row.section_id };
}

export function updateSection(db, input, session) {
  const row = find(db.Sections, 'section_id', input.section_id, 'Section');
  const value = validateSection(db, input, row);
  const before = { ...row };
  Object.assign(row, value);
  writeAudit(db, session, { action: 'SECTION_UPDATE', entityType: 'Sections', entityId: row.section_id, before, after: { ...row } });
  return { section_id: row.section_id };
}

export function setSectionStatus(db, { section_id, status }, session) {
  return changeStatus(db, session, {
    rows: db.Sections, key: 'section_id', id: section_id, status, label: 'Section', entityType: 'Sections',
    blockers: (row) => [
      countLabel(db.Students.filter((s) => s.section_id === row.section_id && s.account_status === 'active').length, 'active student'),
      countLabel(db.Classes.filter((c) => c.section_id === row.section_id && c.status === 'active').length, 'active class', 'active classes'),
    ],
  });
}

// ---------- Subjects ----------

export function listSubjects(db) {
  return {
    items: [...db.Subjects]
      .sort((a, b) => a.subject_code.localeCompare(b.subject_code))
      .map((row) => ({
        ...row,
        units: Number(row.units),
        class_count: db.Classes.filter((c) => c.subject_id === row.subject_id && c.status === 'active').length,
      })),
  };
}

function validateSubject(db, input, existing = null) {
  const errors = {};
  const value = {
    subject_code: text(errors, input.subject_code, 'subject_code', { max: 20, pattern: CODE_PATTERN, patternMessage: 'Use letters, numbers, spaces, or hyphens.' }).toUpperCase(),
    subject_title: text(errors, input.subject_title, 'subject_title', { max: 120 }),
    units: integer(errors, input.units, 'units', 1, 10),
  };
  if (!errors.subject_code && db.Subjects.some((row) => row.subject_code.toLowerCase() === value.subject_code.toLowerCase() && row.subject_id !== existing?.subject_id)) {
    errors.subject_code = 'Another subject already uses this code.';
  }
  failIfErrors(errors);
  return { ...value, units: String(value.units) };
}

export function createSubject(db, input, session) {
  const value = validateSubject(db, input);
  const row = { subject_id: nextId(db.Subjects, 'subject_id', 'SUB'), ...value, status: 'active' };
  db.Subjects.push(row);
  writeAudit(db, session, { action: 'SUBJECT_CREATE', entityType: 'Subjects', entityId: row.subject_id, after: row });
  return { subject_id: row.subject_id };
}

export function updateSubject(db, input, session) {
  const row = find(db.Subjects, 'subject_id', input.subject_id, 'Subject');
  const value = validateSubject(db, input, row);
  const before = { ...row };
  Object.assign(row, value);
  writeAudit(db, session, { action: 'SUBJECT_UPDATE', entityType: 'Subjects', entityId: row.subject_id, before, after: { ...row } });
  return { subject_id: row.subject_id };
}

export function setSubjectStatus(db, { subject_id, status }, session) {
  return changeStatus(db, session, {
    rows: db.Subjects, key: 'subject_id', id: subject_id, status, label: 'Subject', entityType: 'Subjects',
    blockers: (row) => [countLabel(db.Classes.filter((c) => c.subject_id === row.subject_id && c.status === 'active').length, 'active class', 'active classes')],
  });
}

// ---------- Rooms ----------

export function listRooms(db) {
  return {
    items: [...db.Rooms]
      .sort((a, b) => a.room_code.localeCompare(b.room_code))
      .map((row) => {
        const device = db.Devices.find((d) => d.room_id === row.room_id && d.status !== 'retired');
        return {
          ...row,
          schedule_count: db.Schedules.filter((s) => s.room_id === row.room_id && s.status === 'active').length,
          device_id: device?.device_id ?? null,
        };
      }),
  };
}

function validateRoom(db, input, existing = null) {
  const errors = {};
  const value = {
    room_code: text(errors, input.room_code, 'room_code', { max: 20, pattern: ROOM_CODE_PATTERN, patternMessage: 'Use letters, numbers, or hyphens with no spaces (e.g. RM301).' }).toUpperCase(),
    room_name: text(errors, input.room_name, 'room_name', { max: 80 }),
    building: text(errors, input.building, 'building', { max: 80, required: false }),
  };
  if (!errors.room_code && db.Rooms.some((row) => row.room_code.toLowerCase() === value.room_code.toLowerCase() && row.room_id !== existing?.room_id)) {
    errors.room_code = 'Another room already uses this code.';
  }
  failIfErrors(errors);
  return value;
}

export function createRoom(db, input, session) {
  const value = validateRoom(db, input);
  const row = { room_id: nextId(db.Rooms, 'room_id', 'ROM'), ...value, status: 'active' };
  db.Rooms.push(row);
  writeAudit(db, session, { action: 'ROOM_CREATE', entityType: 'Rooms', entityId: row.room_id, after: row });
  return { room_id: row.room_id };
}

export function updateRoom(db, input, session) {
  const row = find(db.Rooms, 'room_id', input.room_id, 'Room');
  const value = validateRoom(db, input, row);
  const before = { ...row };
  Object.assign(row, value);
  writeAudit(db, session, { action: 'ROOM_UPDATE', entityType: 'Rooms', entityId: row.room_id, before, after: { ...row } });
  return { room_id: row.room_id };
}

export function setRoomStatus(db, { room_id, status }, session) {
  return changeStatus(db, session, {
    rows: db.Rooms, key: 'room_id', id: room_id, status, label: 'Room', entityType: 'Rooms',
    blockers: (row) => [
      countLabel(db.Schedules.filter((s) => s.room_id === row.room_id && s.status === 'active').length, 'active schedule'),
      db.Devices.some((d) => d.room_id === row.room_id && d.status !== 'retired') ? 'a device is still assigned to it' : '',
    ],
  });
}
