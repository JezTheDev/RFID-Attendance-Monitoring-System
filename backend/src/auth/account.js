// auth.login, auth.logout, auth.me, auth.changePassword.
// Never return or log a password or a hash.
import { AppError, validationError, setting, toManilaIso, writeAudit } from '../utils.js';
import { hashIterations } from './passwords.js';
import { startSession, displayName, revokeSessions, isTrue } from './session.js';

const MINUTE = 60000;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

export function normalizeUsername(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function findUserByUsername(db, username) {
  const wanted = normalizeUsername(username);
  if (!wanted) return null;
  return db.Users.find((row) => normalizeUsername(row.username) === wanted) ?? null;
}

export function positiveSetting(db, key, fallback) {
  const value = Math.floor(Number(setting(db, key, fallback)));
  return value > 0 ? value : fallback;
}

function invalidCredentials() {
  return new AppError('INVALID_CREDENTIALS', 'Incorrect username or password.');
}

function accountLocked(minutes) {
  return new AppError('ACCOUNT_LOCKED', `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or ask the administrator to unlock your account.`);
}

// Login failures change the Sheet (counter, lock, audit row), so Server.gs
// must save them even though the request fails.
function saved(error) {
  error.commit = true;
  return error;
}

function audit(db, user, action, reason = '') {
  writeAudit(db, { user_id: user ? user.user_id : '', role: user ? user.role : '' }, {
    action, entityType: 'Users', entityId: user ? user.user_id : '', reason,
  });
}

export function login(db, request, _session, ctx) {
  ctx.pepper(); // fail with NOT_CONFIGURED before touching anything
  const password = String(request.password ?? '');
  const nowMs = ctx.now();
  const user = findUserByUsername(db, request.username);

  if (!user) {
    ctx.hash(password); // same work as a real check, so timing does not reveal unknown usernames
    // The attempted username is NOT logged: people sometimes type their password there.
    audit(db, null, 'LOGIN_FAILED', 'unknown username');
    throw saved(invalidCredentials());
  }

  const lockedUntil = Date.parse(user.locked_until);
  if (lockedUntil > nowMs) {
    audit(db, user, 'LOGIN_FAILED', 'account locked');
    throw saved(accountLocked(Math.ceil((lockedUntil - nowMs) / MINUTE)));
  }
  if (user.locked_until) { // the lock has expired: start counting again
    user.locked_until = '';
    user.failed_attempts = '0';
  }

  if (!user.password_hash || !ctx.verify(password, user.password_hash)) {
    if (!user.password_hash) ctx.hash(password);
    const attempts = (Number(user.failed_attempts) || 0) + 1;
    user.failed_attempts = String(attempts);
    audit(db, user, 'LOGIN_FAILED', 'wrong password');
    if (attempts >= positiveSetting(db, 'max_login_attempts', 5)) {
      const minutes = positiveSetting(db, 'lockout_minutes', 15);
      user.locked_until = toManilaIso(nowMs + minutes * MINUTE);
      audit(db, user, 'ACCOUNT_LOCKED', `${attempts} failed attempts`);
      throw saved(accountLocked(minutes));
    }
    throw saved(invalidCredentials());
  }

  // Only someone with the right password learns that the account is disabled.
  if (user.account_status !== 'active') {
    audit(db, user, 'LOGIN_FAILED', 'account disabled');
    throw saved(new AppError('ACCOUNT_DISABLED', 'Your account is disabled. Contact the administrator.'));
  }

  // Checked only after the right password, so a guesser learns nothing.
  if (Date.parse(user.temp_password_expires_at) <= nowMs) {
    audit(db, user, 'LOGIN_FAILED', 'temporary password expired');
    throw saved(new AppError('TEMP_PASSWORD_EXPIRED', 'Your temporary password has expired. Ask the admin to reset your password.'));
  }

  user.failed_attempts = '0';
  user.locked_until = '';
  if (hashIterations(user.password_hash) < ctx.iterations) user.password_hash = ctx.hash(password);
  const { token, expires_at: expiresAt } = startSession(db, user, ctx);
  user.last_login_at = toManilaIso(nowMs);
  audit(db, user, 'LOGIN_SUCCESS');
  return {
    session_token: token,
    user_id: user.user_id,
    username: user.username,
    role: user.role,
    display_name: displayName(db, user),
    email: user.email || '',
    must_change_password: isTrue(user.must_change_password),
    expires_at: expiresAt,
  };
}

export function logout(db, request, _session, ctx) {
  if (!request.session_token) return {};
  const tokenHash = ctx.tokenHash(String(request.session_token));
  db.AuthSessions.forEach((row) => { if (row.token_hash === tokenHash) row.revoked = 'TRUE'; });
  return {};
}

function currentUser(db, session) {
  const user = db.Users.find((row) => row.user_id === session.user_id);
  if (!user) throw new AppError('NOT_SIGNED_IN', 'Your session has ended. Please sign in again.');
  return user;
}

export function me(db, _request, session) {
  const user = currentUser(db, session);
  return {
    user_id: user.user_id,
    username: user.username,
    role: user.role,
    display_name: displayName(db, user),
    email: user.email || '',
    must_change_password: isTrue(user.must_change_password),
    last_login_at: user.last_login_at || null,
    expires_at: session.expires_at,
  };
}

// Throws VALIDATION_ERROR { new_password } if the new password breaks a rule.
export function validateNewPassword(oldPassword, newPassword) {
  let problem = '';
  if (newPassword.length < MIN_PASSWORD) problem = `Use at least ${MIN_PASSWORD} characters.`;
  else if (newPassword.length > MAX_PASSWORD) problem = `Use ${MAX_PASSWORD} characters or fewer.`;
  else if (!/\p{L}/u.test(newPassword) || !/\d/.test(newPassword)) problem = 'Use both letters and numbers.';
  else if (oldPassword !== null && newPassword === oldPassword) problem = 'Choose a password different from your current one.';
  if (problem) throw validationError({ new_password: problem });
}

export function changePassword(db, request, session, ctx) {
  const user = currentUser(db, session);
  const oldPassword = String(request.old_password ?? '');
  const newPassword = String(request.new_password ?? '');
  // A wrong current password is not counted toward the login lockout.
  if (!user.password_hash || !ctx.verify(oldPassword, user.password_hash)) {
    throw validationError({ old_password: 'Your current password is incorrect.' });
  }
  validateNewPassword(oldPassword, newPassword);

  const now = toManilaIso(ctx.now());
  user.password_hash = ctx.hash(newPassword);
  user.must_change_password = 'FALSE';
  user.temp_password_expires_at = '';
  user.password_changed_at = now;
  user.failed_attempts = '0';
  user.locked_until = '';
  user.updated_at = now;
  const revoked = revokeSessions(db, user.user_id, session.token_hash);
  audit(db, user, 'PASSWORD_CHANGED', revoked ? `${revoked} other session(s) signed out` : '');
  return { must_change_password: false, other_sessions_revoked: revoked };
}
