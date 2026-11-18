// One-time account jobs run from the Apps Script editor (see Server.gs):
//   migrateUsersToPasswordLogin - Google-era Users tab -> username + password
//   createBootstrapAdmin         - first admin when there is none
// Both return/throw without saving; Server.gs saves only when they succeed.
import { AppError, validationError, writeAudit } from '../utils.js';
import { normalizeUsername, validateNewPassword } from './account.js';
import { USER_COLUMNS, newUserRow, usernameProblem } from './admin-users.js';

const LOGIN_SETTINGS = [
  { key: 'max_login_attempts', value: '5', description: 'Failed sign-ins in a row before the account is locked', source: 'Login design (Step 2)' },
  { key: 'lockout_minutes', value: '15', description: 'How long a locked account stays locked', source: 'Login design (Step 2)' },
];
const REMOVED_SETTINGS = ['allowed_email_rule'];
const ROLE_ORDER = { student: 0, instructor: 1, admin: 2 };

function baseUsername(user) {
  const local = String(user.email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const base = local.length >= 3 ? local : String(user.user_id).toLowerCase();
  return base.slice(0, 30);
}

function uniqueUsername(base, taken) {
  let candidate = base;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}${n}`;
  return candidate;
}

// Returns a list of what changed (empty when there was nothing to do).
// Never logs passwords or hashes.
export function migrateUsersToPasswordLogin(db, ctx) {
  const changes = [];

  // Check every needed property first, so a missing one stops before any change.
  ctx.pepper();
  const needsPassword = db.Users.filter((user) => !user.password_hash);
  const defaults = {};
  needsPassword.forEach((user) => {
    if (!(user.role in defaults)) defaults[user.role] = ctx.defaultPassword(user.role);
  });

  // 1. Columns: every Users column exists; google_sub is removed.
  db.Users = db.Users.map((user) => {
    const row = {};
    const missing = USER_COLUMNS.filter((col) => !(col in user));
    USER_COLUMNS.forEach((col) => { row[col] = user[col] === undefined || user[col] === null ? '' : String(user[col]); });
    Object.keys(user).forEach((col) => { if (!(col in row) && col !== 'google_sub') row[col] = user[col]; });
    if (missing.length) changes.push(`${user.user_id}: added columns ${missing.join(', ')}`);
    if ('google_sub' in user) changes.push(`${user.user_id}: google_sub removed${user.google_sub ? ' (was linked)' : ''}`);
    if (row.failed_attempts === '') row.failed_attempts = '0';
    return row;
  });

  // 2. Usernames. Existing ones are kept (normalized); students get their
  //    student number; instructors/admins the email local part, de-duplicated.
  const taken = new Set();
  db.Users.forEach((user) => {
    const clean = normalizeUsername(user.username);
    if (clean && clean !== user.username) {
      changes.push(`${user.user_id}: username "${user.username}" normalized to "${clean}"`);
      user.username = clean;
    }
    if (clean) taken.add(clean);
  });
  const studentNumbers = new Map(db.Students.map((row) => [row.student_id, normalizeUsername(row.student_number)]));
  const pending = db.Users
    .map((user, index) => ({ user, index }))
    .filter(({ user }) => !user.username)
    .sort((a, b) => ((ROLE_ORDER[a.user.role] ?? 3) - (ROLE_ORDER[b.user.role] ?? 3)) || a.index - b.index);
  pending.forEach(({ user }) => {
    if (user.role === 'student') {
      const number = studentNumbers.get(user.linked_id);
      if (!number || taken.has(number)) {
        changes.push(`${user.user_id}: PROBLEM - could not use student number "${number || '(none)'}" as username; set it by hand`);
        return;
      }
      user.username = number;
    } else {
      user.username = uniqueUsername(baseUsername(user), taken);
    }
    taken.add(user.username);
    changes.push(`${user.user_id}: username set to "${user.username}"`);
  });

  // 3. Default password (hashed) + forced change, only where there is no password yet.
  db.Users.forEach((user) => {
    if (user.password_hash) return;
    user.password_hash = ctx.hash(defaults[user.role]);
    user.must_change_password = 'TRUE';
    user.failed_attempts = '0';
    user.locked_until = '';
    changes.push(`${user.user_id}: default ${user.role} password set, must change at first sign-in`);
  });

  // 4. Settings.
  const before = db.Settings.length;
  db.Settings = db.Settings.filter((row) => !REMOVED_SETTINGS.includes(row.key));
  if (db.Settings.length !== before) changes.push(`Settings: removed ${REMOVED_SETTINGS.join(', ')}`);
  LOGIN_SETTINGS.forEach((row) => {
    if (db.Settings.some((item) => item.key === row.key)) return;
    db.Settings.push({ ...row });
    changes.push(`Settings: added ${row.key} = ${row.value}`);
  });

  return changes;
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
  validateNewPassword(ctx, 'admin', null, password);

  const row = newUserRow(db, ctx, { username, role: 'admin', displayName: 'Administrator' }, { user_id: 'bootstrap' });
  row.password_hash = ctx.hash(password);
  db.Users.push(row);
  writeAudit(db, { user_id: '', role: 'system' }, {
    action: 'BOOTSTRAP_ADMIN', entityType: 'Users', entityId: row.user_id, after: { username: row.username },
  });
  return { user_id: row.user_id, username: row.username };
}
