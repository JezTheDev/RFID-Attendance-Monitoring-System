import {
  AppError, validationError, toManilaIso, indexBy, fullName, cleanText, writeAudit, nextId, effectiveStatus, bumpRosterVersion,
} from '../utils.js';
import { enrollInSectionClasses, dropSectionClasses } from './classes.js';
import { newUserRow, issueTempPassword, usernameTaken, accountSummary } from '../auth/admin-users.js';

const STUDENT_NUMBER_PATTERN = /^\d{10}$/;
const NAME_PATTERN = /^\p{L}[\p{L}\p{M} .'-]*$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const UID_PATTERN = /^(?:[0-9A-F]{8}|[0-9A-F]{14}|[0-9A-F]{20})$/;
const REPLACE_REASONS = { lost: 'lost', damaged: 'revoked', other: 'revoked' };

export function normalizeUid(value) {
  return String(value ?? '').toUpperCase().replace(/[\s:-]/g, '');
}

function sectionLabel(db, sectionId) {
  const section = db.Sections.find((row) => row.section_id === sectionId);
  if (!section) return '';
  const program = db.Programs.find((row) => row.program_id === section.program_id);
  return `${program?.program_code ?? ''} ${section.section_name}`.trim();
}

function activeCardOf(db, studentId) {
  return db.RfidCards.find((row) => row.student_id === studentId && row.status === 'active') ?? null;
}

function userOf(db, studentId) {
  return db.Users.find((row) => row.role === 'student' && row.linked_id === studentId) ?? null;
}

function findStudent(db, studentId) {
  const student = db.Students.find((row) => row.student_id === studentId);
  if (!student) throw new AppError('NOT_FOUND', 'Student not found.');
  return student;
}

function cardSummary(card) {
  return card ? { card_id: card.card_id, rfid_uid: card.rfid_uid, status: card.status, assigned_at: card.assigned_at } : null;
}

function toListItem(db, student) {
  return {
    student_id: student.student_id,
    student_number: student.student_number,
    first_name: student.first_name,
    last_name: student.last_name,
    section_id: student.section_id,
    section_label: sectionLabel(db, student.section_id),
    year_level: Number(student.year_level),
    email: student.email,
    account_status: student.account_status,
    card: cardSummary(activeCardOf(db, student.student_id)),
  };
}

export function getStudentOptions(db) {
  return {
    sections: db.Sections
      .filter((row) => row.status === 'active')
      .map((row) => ({ section_id: row.section_id, label: sectionLabel(db, row.section_id), year_level: Number(row.year_level) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

export function listStudents(db, { search = '', section_id = '', status = 'active', card = 'all', page = 1, page_size = 20 }) {
  if (!['active', 'inactive', 'all'].includes(status)) throw new AppError('BAD_REQUEST', 'Invalid status filter.');
  if (!['all', 'with', 'without'].includes(card)) throw new AppError('BAD_REQUEST', 'Invalid card filter.');
  const pageNumber = Math.max(1, Math.floor(Number(page)) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(page_size)) || 20));
  const term = cleanText(search).toLowerCase();
  const uidTerm = normalizeUid(search);

  const matches = db.Students.filter((student) => {
    if (status !== 'all' && student.account_status !== status) return false;
    if (section_id && student.section_id !== section_id) return false;
    const activeCard = activeCardOf(db, student.student_id);
    if (card === 'with' && !activeCard) return false;
    if (card === 'without' && activeCard) return false;
    if (!term) return true;
    const haystack = `${student.first_name} ${student.last_name} ${student.last_name} ${student.first_name} ${student.student_number} ${student.email}`.toLowerCase();
    return haystack.includes(term) || (uidTerm.length >= 4 && activeCard?.rfid_uid.includes(uidTerm));
  }).sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name));

  const activeStudents = db.Students.filter((row) => row.account_status === 'active');
  return {
    items: matches.slice((pageNumber - 1) * pageSize, pageNumber * pageSize).map((row) => toListItem(db, row)),
    total: matches.length,
    page: pageNumber,
    page_size: pageSize,
    counts: {
      active: activeStudents.length,
      inactive: db.Students.length - activeStudents.length,
      without_card: activeStudents.filter((row) => !activeCardOf(db, row.student_id)).length,
    },
  };
}

export function getStudent(db, { student_id }, _session, ctx) {
  const student = findStudent(db, student_id);
  const user = userOf(db, student_id);
  const classes = indexBy(db.Classes, 'class_id');
  const subjects = indexBy(db.Subjects, 'subject_id');
  const attendance = db.Attendance.filter((row) => row.student_id === student_id);
  return {
    student: toListItem(db, student),
    account: user ? { ...accountSummary(user, ctx), email: user.email, account_status: user.account_status } : null,
    cards: db.RfidCards
      .filter((row) => row.student_id === student_id)
      .sort((a, b) => b.assigned_at.localeCompare(a.assigned_at))
      .map((row) => ({ ...cardSummary(row), revoked_at: row.revoked_at || null, notes: row.notes })),
    enrollments: db.Enrollments
      .filter((row) => row.student_id === student_id)
      .map((row) => {
        const klass = classes.get(row.class_id);
        return {
          class_id: row.class_id,
          class_label: klass?.class_label ?? row.class_id,
          subject_title: subjects.get(klass?.subject_id)?.subject_title ?? '',
          status: row.status,
        };
      }),
    attendance: {
      records: attendance.length,
      late: attendance.filter((row) => effectiveStatus(row) === 'late').length,
      last_scan_at: attendance.map((row) => row.scanned_at).sort().pop() ?? null,
    },
  };
}

function validateStudentInput(db, input, existing = null) {
  const errors = {};
  const ownUserId = existing ? userOf(db, existing.student_id)?.user_id ?? null : null;
  const value = {
    student_number: cleanText(input.student_number),
    first_name: cleanText(input.first_name),
    last_name: cleanText(input.last_name),
    section_id: cleanText(input.section_id),
    email: cleanText(input.email).toLowerCase(),
  };

  if (!STUDENT_NUMBER_PATTERN.test(value.student_number)) {
    errors.student_number = 'Student number must be exactly 10 digits.';
  } else if (db.Students.some((row) => row.student_number === value.student_number && row.student_id !== existing?.student_id)) {
    errors.student_number = 'Another student already uses this student number.';
  } else if (usernameTaken(db, value.student_number, ownUserId)) {
    // The student number is the student's username, and usernames are unique across all accounts.
    errors.student_number = 'This student number is already used as a username by another account.';
  }

  for (const field of ['first_name', 'last_name']) {
    if (!value[field]) errors[field] = 'This field is required.';
    else if (value[field].length > 60) errors[field] = 'Use 60 characters or fewer.';
    else if (!NAME_PATTERN.test(value[field])) errors[field] = 'Use letters, spaces, periods, apostrophes, or hyphens only.';
  }

  if (!db.Sections.some((row) => row.section_id === value.section_id && row.status === 'active')) {
    errors.section_id = 'Choose a section.';
  }

  // Email is optional; when given it must be valid and not used by another account.
  if (value.email && (!EMAIL_PATTERN.test(value.email) || value.email.length > 120)) {
    errors.email = 'Enter a valid email address.';
  } else if (value.email && db.Users.some((row) => row.email === value.email && row.user_id !== ownUserId)) {
    errors.email = 'This email is already registered to another account.';
  }

  if (Object.keys(errors).length) throw validationError(errors);
  return value;
}

export function createStudent(db, input, session, ctx) {
  const value = validateStudentInput(db, input);
  const section = db.Sections.find((row) => row.section_id === value.section_id);
  const student = {
    student_id: nextId(db.Students, 'student_id', 'STU'),
    student_number: value.student_number,
    first_name: value.first_name,
    last_name: value.last_name,
    program_id: section.program_id,
    year_level: section.year_level,
    section_id: section.section_id,
    email: value.email,
    account_status: 'active',
  };
  // Username = student number; a random temporary password, shown to the admin once.
  const user = newUserRow(db, ctx, { username: value.student_number, email: value.email, role: 'student', linkedId: student.student_id }, session);
  const issued = issueTempPassword(db, ctx, user);
  db.Students.push(student);
  db.Users.push(user);
  const classesJoined = enrollInSectionClasses(db, ctx, student.student_id, student.section_id).length;
  writeAudit(db, session, { action: 'STUDENT_CREATE', entityType: 'Students', entityId: student.student_id, after: { ...student, classes_joined: classesJoined } }, ctx);
  return { student_id: student.student_id, classes_joined: classesJoined, ...issued };
}

export function updateStudent(db, input, session, ctx) {
  const student = findStudent(db, input.student_id);
  const value = validateStudentInput(db, input, student);
  const before = { ...student };
  const section = db.Sections.find((row) => row.section_id === value.section_id);
  Object.assign(student, {
    student_number: value.student_number,
    first_name: value.first_name,
    last_name: value.last_name,
    program_id: section.program_id,
    year_level: section.year_level,
    section_id: section.section_id,
    email: value.email,
  });

  if (before.first_name !== student.first_name || before.last_name !== student.last_name) bumpRosterVersion(db); // roster names

  const user = userOf(db, student.student_id);
  if (user) {
    user.username = value.student_number; // the username follows the student number
    user.email = value.email;
    user.updated_at = toManilaIso(ctx.now());
  }

  // BUG-2: a new section moves the enrollments in the same save (classes of other sections stay).
  const changes = { dropped: [], enrolled: [] };
  const auditBefore = { ...before };
  const after = { ...student };
  if (before.section_id !== student.section_id) {
    auditBefore.enrolled_classes = enrolledClassIds(db, student.student_id);
    changes.dropped = dropSectionClasses(db, student.student_id, before.section_id).map((row) => row.class_label);
    changes.enrolled = enrollInSectionClasses(db, ctx, student.student_id, student.section_id).map((row) => row.class_label);
    after.enrolled_classes = enrolledClassIds(db, student.student_id);
  }

  writeAudit(db, session, { action: 'STUDENT_UPDATE', entityType: 'Students', entityId: student.student_id, before: auditBefore, after }, ctx);
  return { student_id: student.student_id, enrollment_changes: changes };
}

function enrolledClassIds(db, studentId) {
  return db.Enrollments.filter((row) => row.student_id === studentId && row.status === 'enrolled').map((row) => row.class_id).sort();
}

export function setStudentStatus(db, { student_id, status, reason }, session, ctx) {
  const student = findStudent(db, student_id);
  if (!['active', 'inactive'].includes(status)) throw new AppError('BAD_REQUEST', 'Invalid status.');
  if (student.account_status === status) throw new AppError('NO_CHANGE', `This student is already ${status}.`);
  const cleanReason = cleanText(reason);
  if (cleanReason.length < 3) throw validationError({ reason: 'Please give a short reason.' });

  const now = toManilaIso(ctx.now());
  const user = userOf(db, student_id);
  const before = { account_status: student.account_status };
  student.account_status = status;
  if (user) {
    user.account_status = status === 'active' ? 'active' : 'disabled';
    user.updated_at = now;
  }

  let revokedCard = null;
  if (status === 'inactive') {
    const card = activeCardOf(db, student_id);
    if (card) {
      card.status = 'revoked';
      card.revoked_at = now;
      card.notes = cleanText(`${card.notes} Revoked: student deactivated.`);
      revokedCard = card.card_id;
    }
  }
  bumpRosterVersion(db); // every status change: covers legacy inactive students who kept an active card

  writeAudit(db, session, {
    action: status === 'active' ? 'STUDENT_ACTIVATE' : 'STUDENT_DEACTIVATE',
    entityType: 'Students', entityId: student_id, before, after: { account_status: status, revoked_card: revokedCard }, reason: cleanReason,
  }, ctx);
  return { student_id, account_status: status, revoked_card_id: revokedCard };
}

export function assignCard(db, { student_id, rfid_uid, replace_reason = '', note = '' }, session, ctx) {
  const student = findStudent(db, student_id);
  if (student.account_status !== 'active') {
    throw new AppError('STUDENT_INACTIVE', 'Activate this student before assigning a card.');
  }
  const uid = normalizeUid(rfid_uid);
  if (!UID_PATTERN.test(uid)) {
    throw validationError({ rfid_uid: 'UID must be 8, 14, or 20 hexadecimal characters (0–9, A–F).' });
  }

  const activeWithUid = db.RfidCards.find((row) => row.rfid_uid === uid && row.status === 'active');
  if (activeWithUid && activeWithUid.student_id === student_id) {
    throw validationError({ rfid_uid: 'This card is already the student\'s active card.' });
  }
  if (activeWithUid) {
    const owner = db.Students.find((row) => row.student_id === activeWithUid.student_id);
    throw validationError({ rfid_uid: `This card is already assigned to ${fullName(owner)} (${owner?.student_number}).` });
  }
  const otherHistory = db.RfidCards.find((row) => row.rfid_uid === uid && row.student_id !== student_id);
  if (otherHistory) {
    throw validationError({ rfid_uid: `This card was previously registered to another student and is marked ${otherHistory.status}. Use a different card.` });
  }

  const current = activeCardOf(db, student_id);
  const now = toManilaIso(ctx.now());
  const cleanNote = cleanText(note).slice(0, 200);
  if (current) {
    if (!REPLACE_REASONS[replace_reason]) throw validationError({ replace_reason: 'Choose why the current card is being replaced.' });
    current.status = REPLACE_REASONS[replace_reason];
    current.revoked_at = now;
    current.notes = cleanText(`${current.notes} Replaced (${replace_reason}).`);
  }

  const card = {
    card_id: nextId(db.RfidCards, 'card_id', 'CRD'),
    rfid_uid: uid,
    student_id,
    status: 'active',
    assigned_at: now,
    revoked_at: '',
    notes: cleanNote || (current ? `Replacement for ${current.card_id}` : ''),
  };
  db.RfidCards.push(card);
  bumpRosterVersion(db);
  writeAudit(db, session, {
    action: current ? 'CARD_REPLACE' : 'CARD_ASSIGN',
    entityType: 'RfidCards',
    entityId: card.card_id,
    before: current ? { card_id: current.card_id, status: 'active' } : null,
    after: { card_id: card.card_id, rfid_uid: uid, student_id },
    reason: current ? replace_reason : '',
  }, ctx);
  return { card_id: card.card_id, replaced_card_id: current?.card_id ?? null };
}

export function revokeCard(db, { student_id, reason }, session, ctx) {
  findStudent(db, student_id);
  const card = activeCardOf(db, student_id);
  if (!card) throw new AppError('NO_ACTIVE_CARD', 'This student has no active card.');
  const cleanReason = cleanText(reason);
  if (cleanReason.length < 3) throw validationError({ reason: 'Please give a short reason.' });
  card.status = 'revoked';
  card.revoked_at = toManilaIso(ctx.now());
  card.notes = cleanText(`${card.notes} Revoked: ${cleanReason}`);
  bumpRosterVersion(db);
  writeAudit(db, session, {
    action: 'CARD_REVOKE', entityType: 'RfidCards', entityId: card.card_id,
    before: { status: 'active' }, after: { status: 'revoked' }, reason: cleanReason,
  }, ctx);
  return { card_id: card.card_id };
}

export function listUnregisteredUids(db) {
  const knownUids = new Set(db.RfidCards.map((row) => row.rfid_uid));
  const rooms = indexBy(db.Rooms, 'room_id');
  const devices = indexBy(db.Devices, 'device_id');
  const grouped = new Map();
  db.ScanLog
    .filter((row) => row.result === 'UNREGISTERED' && !knownUids.has(row.rfid_uid))
    .forEach((row) => {
      const entry = grouped.get(row.rfid_uid) ?? { rfid_uid: row.rfid_uid, scan_count: 0, last_seen_at: '', room_code: '' };
      entry.scan_count += 1;
      if (row.scanned_at > entry.last_seen_at) {
        entry.last_seen_at = row.scanned_at;
        entry.room_code = rooms.get(devices.get(row.device_id)?.room_id)?.room_code ?? '';
      }
      grouped.set(row.rfid_uid, entry);
    });
  return { items: [...grouped.values()].sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at)).slice(0, 20) };
}
