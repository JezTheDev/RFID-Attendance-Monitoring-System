// Editor-only account jobs (see Server.gs):
//   createBootstrapAdmin - first admin when there is none (production + TEST)
//   seedTestPasswords    - FAKE seeded users of a TEST Sheet get TEST_SEED_PASSWORD
//   resetTestUserPassword - one TEST Sheet user back on TEST_SEED_PASSWORD
// Both return/throw without saving; Server.gs saves only when they succeed.
import { AppError, validationError, writeAudit, toManilaIso } from '../utils.js';
import { normalizeUsername, validateNewPassword } from './account.js';
import { newUserRow, usernameProblem } from './admin-users.js';
import { revokeSessions } from './session.js';

// TEST Sheet only: every seeded FAKE user without a password gets the
// TEST_SEED_PASSWORD Script Property (hashed) and must change it.
export function seedTestPasswords(db, ctx) {
  const password = ctx.property('TEST_SEED_PASSWORD');
  if (!password) throw new AppError('NOT_CONFIGURED', 'Set the TEST_SEED_PASSWORD Script Property first (fake test users only).');
  const users = db.Users.filter((user) => !user.password_hash);
  users.forEach((user) => {
    user.password_hash = ctx.hash(password);
    user.must_change_password = 'TRUE';
    user.failed_attempts = '0';
  });
  return [`${users.length} test user(s) got the TEST_SEED_PASSWORD (must change at first sign-in).`];
}

// TEST Sheet only: puts one user back on TEST_SEED_PASSWORD (must change it at
// next sign-in) and signs them out everywhere. Never logs the password.
export function resetTestUserPassword(db, ctx, username) {
  const password = ctx.property('TEST_SEED_PASSWORD');
  if (!password) {
    throw new AppError('NOT_TEST_SHEET', 'resetTestUserPassword is for the TEST Sheet only (TEST_SEED_PASSWORD is not set). Use the Admin portal instead.');
  }
  const wanted = normalizeUsername(username);
  const user = wanted ? db.Users.find((row) => normalizeUsername(row.username) === wanted) : null;
  if (!user) throw new AppError('NOT_FOUND', `No user with username "${wanted}".`);
  user.password_hash = ctx.hash(password);
  user.must_change_password = 'TRUE';
  user.failed_attempts = '0';
  user.locked_until = '';
  user.temp_password_expires_at = '';
  user.updated_at = toManilaIso(ctx.now());
  const revoked = revokeSessions(db, user.user_id);
  return [`Password reset for ${user.username} (${revoked} session(s) signed out; must change at next sign-in).`];
}

// Creates the first admin from BOOTSTRAP_ADMIN_USERNAME / BOOTSTRAP_ADMIN_PASSWORD.
export function createBootstrapAdmin(db, ctx) {
  const username = normalizeUsername(ctx.property('BOOTSTRAP_ADMIN_USERNAME'));
  const password = ctx.property('BOOTSTRAP_ADMIN_PASSWORD');
  if (!username) throw new AppError('NOT_CONFIGURED', 'Set the BOOTSTRAP_ADMIN_USERNAME Script Property first.');
  if (!password) throw new AppError('NOT_CONFIGURED', 'Set the BOOTSTRAP_ADMIN_PASSWORD Script Property first.');
  if (db.Users.some((user) => user.role === 'admin' && user.account_status === 'active')) {
    throw new AppError('ADMIN_EXISTS', 'An active admin already exists. Sign in as that admin instead.');
  }
  const problem = usernameProblem(db, username);
  if (problem) throw validationError({ username: problem });
  validateNewPassword(null, password);

  const row = newUserRow(db, ctx, { username, role: 'admin', displayName: 'Administrator' }, { user_id: 'bootstrap' });
  row.password_hash = ctx.hash(password);
  db.Users.push(row);
  writeAudit(db, { user_id: '', role: 'system' }, {
    action: 'BOOTSTRAP_ADMIN', entityType: 'Users', entityId: row.user_id, after: { username: row.username },
  }, ctx);
  return { user_id: row.user_id, username: row.username };
}
