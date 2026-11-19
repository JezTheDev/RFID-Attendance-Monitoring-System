// Admin accounts. Unlike students and instructors, an admin has no separate
// record: the Users row is the whole account (name stored in display_name).
import {
  AppError, validationError, manilaNow, cleanText, writeAudit,
} from '../utils.js';
import { normalizeUsername } from '../auth/account.js';
import { newUserRow, issueTempPassword, usernameProblem, accountSummary } from '../auth/admin-users.js';

const NAME_PATTERN = /^\p{L}[\p{L}\p{M} .'-]*$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function admins(db) {
  return db.Users.filter((row) => row.role === 'admin');
}

function findAdmin(db, userId) {
  const row = admins(db).find((item) => item.user_id === userId);
  if (!row) throw new AppError('NOT_FOUND', 'Administrator not found.');
  return row;
}

function validate(db, input, existing = null) {
  const errors = {};
  const value = {
    username: normalizeUsername(input.username),
    display_name: cleanText(input.display_name),
    email: cleanText(input.email).toLowerCase(),
  };
  const usernameError = usernameProblem(db, value.username, existing?.user_id ?? null);
  if (usernameError) errors.username = usernameError;
  if (!value.display_name) errors.display_name = 'This field is required.';
  else if (value.display_name.length > 80) errors.display_name = 'Use 80 characters or fewer.';
  else if (!NAME_PATTERN.test(value.display_name)) errors.display_name = 'Use letters, spaces, periods, apostrophes, or hyphens only.';
  // Email is optional; when given it must be valid and not used by another account.
  if (value.email && (!EMAIL_PATTERN.test(value.email) || value.email.length > 120)) {
    errors.email = 'Enter a valid email address.';
  } else if (value.email && db.Users.some((row) => String(row.email).toLowerCase() === value.email && row.user_id !== existing?.user_id)) {
    errors.email = 'This email is already registered to another account.';
  }
  if (Object.keys(errors).length) throw validationError(errors);
  return value;
}

export function listAdmins(db, _request, session, ctx) {
  return {
    items: admins(db)
      .map((row) => ({
        user_id: row.user_id,
        display_name: row.display_name || 'Administrator',
        email: row.email,
        status: row.account_status === 'active' ? 'active' : 'inactive',
        ...accountSummary(row, ctx),
        is_you: row.user_id === session.user_id,
      }))
      .sort((a, b) => a.display_name.localeCompare(b.display_name)),
  };
}

export function createAdmin(db, input, session, ctx) {
  const value = validate(db, input);
  // A random temporary password, shown to the admin once.
  const row = newUserRow(db, ctx, { username: value.username, email: value.email, role: 'admin', displayName: value.display_name }, session);
  const issued = issueTempPassword(db, ctx, row);
  db.Users.push(row);
  writeAudit(db, session, { action: 'ADMIN_CREATE', entityType: 'Users', entityId: row.user_id, after: { username: row.username, email: row.email, display_name: row.display_name } });
  return { user_id: row.user_id, ...issued };
}

export function updateAdmin(db, input, session) {
  const row = findAdmin(db, input.user_id);
  const value = validate(db, input, row);
  const before = { username: row.username, email: row.email, display_name: row.display_name || '' };
  row.username = value.username;
  row.email = value.email;
  row.display_name = value.display_name;
  row.updated_at = manilaNow().iso;
  writeAudit(db, session, { action: 'ADMIN_UPDATE', entityType: 'Users', entityId: row.user_id, before, after: value });
  return { user_id: row.user_id };
}

export function setAdminStatus(db, { user_id: userId, status }, session) {
  const row = findAdmin(db, userId);
  if (!['active', 'inactive'].includes(status)) throw new AppError('BAD_REQUEST', 'Invalid status.');
  const current = row.account_status === 'active' ? 'active' : 'inactive';
  if (current === status) throw new AppError('NO_CHANGE', `This administrator is already ${status}.`);
  if (status === 'inactive') {
    if (userId === session.user_id) throw new AppError('IN_USE', 'You cannot deactivate your own account. Ask another administrator.');
    const activeAdmins = admins(db).filter((item) => item.account_status === 'active');
    if (activeAdmins.length <= 1) throw new AppError('IN_USE', 'There must always be at least one active administrator.');
  }
  row.account_status = status === 'active' ? 'active' : 'disabled';
  row.updated_at = manilaNow().iso;
  if (status === 'inactive') {
    // Sign them out everywhere right away.
    (db.AuthSessions || []).forEach((item) => { if (item.user_id === userId) item.revoked = 'TRUE'; });
  }
  writeAudit(db, session, {
    action: status === 'active' ? 'ADMIN_ACTIVATE' : 'ADMIN_DEACTIVATE',
    entityType: 'Users', entityId: userId, before: { account_status: current }, after: { account_status: row.account_status },
  });
  return { user_id: userId, status };
}
