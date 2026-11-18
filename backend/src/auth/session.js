// Web sessions (AuthSessions tab). Ported from Server.gs: a random token goes to
// the browser, only its SHA-256 is stored, and every request is checked here.
import { AppError, setting, toManilaIso, fullName } from '../utils.js';

export const PUBLIC = 'public'; // no session needed
export const ANY = 'any'; // any signed-in role
// While must_change_password is TRUE, only these actions are allowed.
export const PASSWORD_CHANGE_ALLOWED = Object.freeze(['auth.me', 'auth.changePassword', 'auth.logout']);

export const isTrue = (value) => String(value).toUpperCase() === 'TRUE';

export function displayName(db, user) {
  let person = null;
  if (user.role === 'instructor') person = db.Instructors.find((row) => row.instructor_id === user.linked_id);
  if (user.role === 'student') person = db.Students.find((row) => row.student_id === user.linked_id);
  if (person) return fullName(person);
  if (user.role === 'admin') return user.display_name || 'Administrator';
  return user.username;
}

export function startSession(db, user, ctx) {
  const token = ctx.newToken();
  const hours = Number(setting(db, 'session_token_hours', 8)) || 8;
  const nowMs = ctx.now();
  const expiresAt = toManilaIso(nowMs + hours * 3600000);
  // Drop sessions that ended more than a day ago so the tab stays small.
  const cutoff = nowMs - 86400000;
  db.AuthSessions = db.AuthSessions.filter((row) => Date.parse(row.expires_at) > cutoff);
  db.AuthSessions.push({
    token_hash: ctx.tokenHash(token),
    user_id: user.user_id,
    created_at: toManilaIso(nowMs),
    expires_at: expiresAt,
    revoked: 'FALSE',
  });
  return { token, expires_at: expiresAt };
}

// Returns the session object handlers receive. token_hash stays on the server.
export function authorize(db, token, ctx) {
  const signedOut = new AppError('NOT_SIGNED_IN', 'Your session has ended. Please sign in again.');
  if (!token) throw signedOut;
  const tokenHash = ctx.tokenHash(String(token));
  const row = db.AuthSessions.find((item) => item.token_hash === tokenHash);
  if (!row || isTrue(row.revoked) || !(Date.parse(row.expires_at) > ctx.now())) throw signedOut;
  const user = db.Users.find((item) => item.user_id === row.user_id);
  if (!user || user.account_status !== 'active') throw signedOut;
  return {
    user_id: user.user_id,
    role: user.role,
    username: user.username,
    email: user.email,
    must_change_password: isTrue(user.must_change_password),
    expires_at: row.expires_at,
    token_hash: tokenHash,
  };
}

// Revokes the user's active sessions (except one token hash). Returns how many.
export function revokeSessions(db, userId, exceptTokenHash = '') {
  let count = 0;
  db.AuthSessions.forEach((row) => {
    if (row.user_id === userId && row.token_hash !== exceptTokenHash && !isTrue(row.revoked)) {
      row.revoked = 'TRUE';
      count += 1;
    }
  });
  return count;
}
