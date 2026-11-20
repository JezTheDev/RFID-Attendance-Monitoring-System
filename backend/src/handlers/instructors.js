import { AppError, validationError, toManilaIso, cleanText, writeAudit, nextId } from '../utils.js';
import { normalizeUsername } from '../auth/account.js';
import { newUserRow, issueTempPassword, usernameProblem, accountSummary } from '../auth/admin-users.js';
import { revokeSessions } from '../auth/session.js';

const NAME_PATTERN = /^\p{L}[\p{L}\p{M} .'-]*$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function userOf(db, instructorId) {
  return db.Users.find((row) => row.role === 'instructor' && row.linked_id === instructorId) ?? null;
}

function findInstructor(db, instructorId) {
  const row = db.Instructors.find((item) => item.instructor_id === instructorId);
  if (!row) throw new AppError('NOT_FOUND', 'Instructor not found.');
  return row;
}

function activeClassCount(db, instructorId) {
  return db.Classes.filter((row) => row.instructor_id === instructorId && row.status === 'active').length;
}

export function listInstructors(db, _request, _session, ctx) {
  return {
    items: [...db.Instructors]
      .sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name))
      .map((row) => {
        const user = userOf(db, row.instructor_id);
        return {
          ...row,
          status: row.account_status,
          class_count: activeClassCount(db, row.instructor_id),
          ...(accountSummary(user, ctx) ?? { username: '', must_change_password: false, locked: false, last_login_at: null }),
        };
      }),
  };
}

function validateInstructor(db, input, existing = null) {
  const errors = {};
  const ownUserId = existing ? userOf(db, existing.instructor_id)?.user_id ?? null : null;
  const username = normalizeUsername(input.username);
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

  const usernameError = usernameProblem(db, username, ownUserId);
  if (usernameError) errors.username = usernameError;
  // Email is optional; when given it must be valid and not used by another account.
  if (value.email && (!EMAIL_PATTERN.test(value.email) || value.email.length > 120)) {
    errors.email = 'Enter a valid email address.';
  } else if (value.email && db.Users.some((row) => String(row.email).toLowerCase() === value.email && row.user_id !== ownUserId)) {
    errors.email = 'This email is already registered to another account.';
  }
  if (Object.keys(errors).length) throw validationError(errors);
  return { value, username };
}

export function createInstructor(db, input, session, ctx) {
  const { value, username } = validateInstructor(db, input);
  const instructor = { instructor_id: nextId(db.Instructors, 'instructor_id', 'INS'), ...value, account_status: 'active' };
  // A random temporary password, shown to the admin once.
  const user = newUserRow(db, ctx, { username, email: value.email, role: 'instructor', linkedId: instructor.instructor_id }, session);
  const issued = issueTempPassword(db, ctx, user);
  db.Instructors.push(instructor);
  db.Users.push(user);
  writeAudit(db, session, { action: 'INSTRUCTOR_CREATE', entityType: 'Instructors', entityId: instructor.instructor_id, after: instructor }, ctx);
  return { instructor_id: instructor.instructor_id, ...issued };
}

export function updateInstructor(db, input, session, ctx) {
  const instructor = findInstructor(db, input.instructor_id);
  const { value, username } = validateInstructor(db, input, instructor);
  const before = { ...instructor };
  Object.assign(instructor, value);
  const user = userOf(db, instructor.instructor_id);
  if (user) {
    user.username = username;
    user.email = value.email;
    user.updated_at = toManilaIso(ctx.now());
  }
  writeAudit(db, session, { action: 'INSTRUCTOR_UPDATE', entityType: 'Instructors', entityId: instructor.instructor_id, before, after: { ...instructor, username } }, ctx);
  return { instructor_id: instructor.instructor_id };
}

export function setInstructorStatus(db, { instructor_id, status }, session, ctx) {
  const instructor = findInstructor(db, instructor_id);
  if (!['active', 'inactive'].includes(status)) throw new AppError('BAD_REQUEST', 'Invalid status.');
  if (instructor.account_status === status) throw new AppError('NO_CHANGE', `This instructor is already ${status}.`);
  const classes = activeClassCount(db, instructor_id);
  if (status === 'inactive' && classes > 0) {
    throw new AppError('IN_USE', `Reassign this instructor's ${classes} active class${classes === 1 ? '' : 'es'} before deactivating.`);
  }
  const before = { account_status: instructor.account_status };
  instructor.account_status = status;
  const user = userOf(db, instructor_id);
  if (user) {
    user.account_status = status === 'active' ? 'active' : 'disabled';
    user.updated_at = toManilaIso(ctx.now());
    if (status === 'inactive') revokeSessions(db, user.user_id); // else reactivating revives old tokens
  }
  writeAudit(db, session, {
    action: status === 'active' ? 'INSTRUCTOR_ACTIVATE' : 'INSTRUCTOR_DEACTIVATE',
    entityType: 'Instructors', entityId: instructor_id, before, after: { account_status: status },
  }, ctx);
  return { instructor_id, status };
}
