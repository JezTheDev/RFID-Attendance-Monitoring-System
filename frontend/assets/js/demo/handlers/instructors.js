import { DemoError, validationError, manilaNow, cleanText, writeAudit, nextId } from '../demo-utils.js';

const NAME_PATTERN = /^\p{L}[\p{L}\p{M} .'-]*$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function userOf(db, instructorId) {
  return db.Users.find((row) => row.role === 'instructor' && row.linked_id === instructorId) ?? null;
}

function findInstructor(db, instructorId) {
  const row = db.Instructors.find((item) => item.instructor_id === instructorId);
  if (!row) throw new DemoError('NOT_FOUND', 'Instructor not found.');
  return row;
}

function activeClassCount(db, instructorId) {
  return db.Classes.filter((row) => row.instructor_id === instructorId && row.status === 'active').length;
}

export function listInstructors(db) {
  return {
    items: [...db.Instructors]
      .sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name))
      .map((row) => {
        const user = userOf(db, row.instructor_id);
        return {
          ...row,
          status: row.account_status,
          class_count: activeClassCount(db, row.instructor_id),
          google_linked: Boolean(user?.google_sub),
          last_login_at: user?.last_login_at || null,
        };
      }),
  };
}

function validateInstructor(db, input, existing = null) {
  const errors = {};
  const value = {
    first_name: cleanText(input.first_name),
    last_name: cleanText(input.last_name),
    email: cleanText(input.email).toLowerCase(),
    department: cleanText(input.department),
  };
  for (const field of ['first_name', 'last_name']) {
    if (!value[field]) errors[field] = 'This field is required.';
    else if (value[field].length > 60) errors[field] = 'Use 60 characters or fewer.';
    else if (!NAME_PATTERN.test(value[field])) errors[field] = 'Use letters, spaces, periods, apostrophes, or hyphens only.';
  }
  if (!value.department) errors.department = 'This field is required.';
  else if (value.department.length > 80) errors.department = 'Use 80 characters or fewer.';

  const ownUserId = existing ? userOf(db, existing.instructor_id)?.user_id : null;
  if (!EMAIL_PATTERN.test(value.email) || value.email.length > 120) {
    errors.email = 'Enter a valid email address.';
  } else if (db.Users.some((row) => row.email === value.email && row.user_id !== ownUserId)) {
    errors.email = 'This email is already registered to another account.';
  }
  if (Object.keys(errors).length) throw validationError(errors);
  return value;
}

export function createInstructor(db, input, session) {
  const value = validateInstructor(db, input);
  const now = manilaNow().iso;
  const instructor = { instructor_id: nextId(db.Instructors, 'instructor_id', 'INS'), ...value, account_status: 'active' };
  db.Instructors.push(instructor);
  db.Users.push({
    user_id: nextId(db.Users, 'user_id', 'USR'),
    email: value.email,
    google_sub: '',
    role: 'instructor',
    linked_id: instructor.instructor_id,
    account_status: 'active',
    created_by: session.user_id,
    last_login_at: '',
    created_at: now,
    updated_at: now,
  });
  writeAudit(db, session, { action: 'INSTRUCTOR_CREATE', entityType: 'Instructors', entityId: instructor.instructor_id, after: instructor });
  return { instructor_id: instructor.instructor_id };
}

export function updateInstructor(db, input, session) {
  const instructor = findInstructor(db, input.instructor_id);
  const value = validateInstructor(db, input, instructor);
  const before = { ...instructor };
  Object.assign(instructor, value);
  const user = userOf(db, instructor.instructor_id);
  let googleUnlinked = false;
  if (user && user.email !== value.email) {
    googleUnlinked = Boolean(user.google_sub);
    user.email = value.email;
    user.google_sub = '';
  }
  if (user) user.updated_at = manilaNow().iso;
  writeAudit(db, session, { action: 'INSTRUCTOR_UPDATE', entityType: 'Instructors', entityId: instructor.instructor_id, before, after: { ...instructor } });
  return { instructor_id: instructor.instructor_id, google_unlinked: googleUnlinked };
}

export function setInstructorStatus(db, { instructor_id, status }, session) {
  const instructor = findInstructor(db, instructor_id);
  if (!['active', 'inactive'].includes(status)) throw new DemoError('BAD_REQUEST', 'Invalid status.');
  if (instructor.account_status === status) throw new DemoError('NO_CHANGE', `This instructor is already ${status}.`);
  const classes = activeClassCount(db, instructor_id);
  if (status === 'inactive' && classes > 0) {
    throw new DemoError('IN_USE', `Reassign this instructor's ${classes} active class${classes === 1 ? '' : 'es'} before deactivating.`);
  }
  const before = { account_status: instructor.account_status };
  instructor.account_status = status;
  const user = userOf(db, instructor_id);
  if (user) {
    user.account_status = status === 'active' ? 'active' : 'disabled';
    user.updated_at = manilaNow().iso;
  }
  writeAudit(db, session, {
    action: status === 'active' ? 'INSTRUCTOR_ACTIVATE' : 'INSTRUCTOR_DEACTIVATE',
    entityType: 'Instructors', entityId: instructor_id, before, after: { account_status: status },
  });
  return { instructor_id, status };
}
