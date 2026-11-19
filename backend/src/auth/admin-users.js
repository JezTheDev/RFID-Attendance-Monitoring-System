// Account helpers for the admin side: usernames, new Users rows, temporary
// passwords, admin.resetPassword and admin.unlockUser.
import { AppError, toManilaIso, writeAudit, nextId } from '../utils.js';
import { normalizeUsername, positiveSetting } from './account.js';
import { revokeSessions, isTrue } from './session.js';

// Column order of the Users tab.
export const USER_COLUMNS = Object.freeze([
  'user_id', 'username', 'email', 'role', 'linked_id', 'account_status',
  'password_hash', 'must_change_password', 'failed_attempts', 'locked_until', 'password_changed_at',
  'created_by', 'last_login_at', 'created_at', 'updated_at', 'display_name',
  'temp_password_expires_at',
]);

const DAY = 24 * 60 * 60000;

// Instructors and admins. Students use their 10-digit student number.
export const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;

export function usernameTaken(db, username, ownUserId = null) {
  const wanted = normalizeUsername(username);
  return db.Users.some((row) => normalizeUsername(row.username) === wanted && row.user_id !== ownUserId);
}

// Returns '' when the username is fine, otherwise the message for the form.
export function usernameProblem(db, username, ownUserId = null) {
  if (!username) return 'This field is required.';
  if (!USERNAME_PATTERN.test(username)) return 'Use 3-32 lowercase letters, numbers, dots, hyphens, or underscores.';
  if (usernameTaken(db, username, ownUserId)) return 'This username is already used by another account.';
  return '';
}

function nowMs(ctx) {
  return ctx ? ctx.now() : Date.now();
}

// What the admin pages may show about a login account (never the hash).
export function accountSummary(user, ctx) {
  if (!user) return null;
  return {
    username: user.username || '',
    must_change_password: isTrue(user.must_change_password),
    locked: Date.parse(user.locked_until) > nowMs(ctx),
    last_login_at: user.last_login_at || null,
  };
}

// Gives the user a new random temporary password: stores only its hash, forces
// a change, starts the expiry. Returns the plain value ONCE, for the admin's
// response only; never write it to the Sheet, the AuditLog or a log.
export function issueTempPassword(db, ctx, user) {
  const tempPassword = ctx.newTempPassword();
  user.password_hash = ctx.hash(tempPassword.replace('-', '')); // the dash is display-only (see typedPassword)
  user.must_change_password = 'TRUE';
  user.temp_password_expires_at = toManilaIso(ctx.now() + positiveSetting(db, 'temp_password_days', 7) * DAY);
  return { temp_password: tempPassword, temp_password_expires_at: user.temp_password_expires_at };
}

// Builds (does not save) a Users row with no password yet: the caller gives it
// one with issueTempPassword() before saving it.
export function newUserRow(db, ctx, { username, email = '', role, linkedId = '', displayName = '' }, session) {
  const now = toManilaIso(ctx.now());
  return {
    user_id: nextId(db.Users, 'user_id', 'USR'),
    username: normalizeUsername(username),
    email,
    role,
    linked_id: linkedId,
    account_status: 'active',
    password_hash: '',
    must_change_password: 'TRUE',
    failed_attempts: '0',
    locked_until: '',
    password_changed_at: '',
    created_by: session ? session.user_id : '',
    last_login_at: '',
    created_at: now,
    updated_at: now,
    display_name: displayName,
    temp_password_expires_at: '',
  };
}

function findUser(db, userId) {
  const user = db.Users.find((row) => row.user_id === userId);
  if (!user) throw new AppError('NOT_FOUND', 'Account not found.');
  return user;
}

export function resetPassword(db, { user_id: userId }, session, ctx) {
  const user = findUser(db, userId);
  if (user.user_id === session.user_id) {
    throw new AppError('BAD_REQUEST', 'Use Change password for your own account.');
  }
  const issued = issueTempPassword(db, ctx, user);
  user.failed_attempts = '0';
  user.locked_until = '';
  user.updated_at = toManilaIso(ctx.now());
  const revoked = revokeSessions(db, user.user_id);
  writeAudit(db, session, {
    action: 'PASSWORD_RESET', entityType: 'Users', entityId: user.user_id,
    reason: `New temporary password issued; ${revoked} session(s) signed out`,
  });
  return { user_id: user.user_id, must_change_password: true, sessions_revoked: revoked, ...issued };
}

export function unlockUser(db, { user_id: userId }, session, ctx) {
  const user = findUser(db, userId);
  if (!(Number(user.failed_attempts) > 0) && !user.locked_until) {
    throw new AppError('NO_CHANGE', 'This account is not locked.');
  }
  const before = { failed_attempts: user.failed_attempts, locked_until: user.locked_until };
  user.failed_attempts = '0';
  user.locked_until = '';
  user.updated_at = toManilaIso(ctx.now());
  writeAudit(db, session, {
    action: 'USER_UNLOCKED', entityType: 'Users', entityId: user.user_id,
    before, after: { failed_attempts: '0', locked_until: '' },
  });
  return { user_id: user.user_id };
}
