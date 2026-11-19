// migrateUsersToPasswordLogin (existing Google-era Sheet -> password login),
// createBootstrapAdmin, and the fake seed data.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDb, withCode } from './helpers/db.js';
import { makeCtx, TEST_PROPS } from './helpers/auth.js';
import { migrateUsersToPasswordLogin, createBootstrapAdmin, seedTestPasswords } from '../src/auth/migration.js';
import { USER_COLUMNS, resetPassword } from '../src/auth/admin-users.js';
import { runAction } from '../src/actions.js';

// The Users/Settings tabs as they were before this change (Google Sign-In era).
function googleEraDb() {
  const db = makeDb();
  db.Users = [
    { user_id: 'USR-0001', email: 'Head.Admin@psu.edu.ph', google_sub: '1111', role: 'admin', linked_id: '', account_status: 'active', created_by: '', last_login_at: '', created_at: '', updated_at: '', display_name: 'Head Admin' },
    { user_id: 'USR-0002', email: 'ana@psu.edu.ph', google_sub: '2222', role: 'instructor', linked_id: 'INS-0001', account_status: 'active', created_by: '', last_login_at: '', created_at: '', updated_at: '' },
    { user_id: 'USR-0003', email: 'ana@gmail.com', google_sub: '', role: 'instructor', linked_id: 'INS-0002', account_status: 'disabled', created_by: '', last_login_at: '', created_at: '', updated_at: '' },
    { user_id: 'USR-0004', email: 's1@example.com', google_sub: '4444', role: 'student', linked_id: 'STU-0001', account_status: 'active', created_by: '', last_login_at: '', created_at: '', updated_at: '' },
    { user_id: 'USR-0005', email: '', google_sub: '', role: 'student', linked_id: 'STU-0004', account_status: 'active', created_by: '', last_login_at: '', created_at: '', updated_at: '' },
    { user_id: 'USR-0006', email: '', google_sub: '', role: 'admin', linked_id: '', account_status: 'active', created_by: '', last_login_at: '', created_at: '', updated_at: '' },
  ];
  db.Settings = db.Settings
    .filter((row) => !['max_login_attempts', 'lockout_minutes'].includes(row.key))
    .concat([{ key: 'allowed_email_rule', value: 'gmail_or_hd', description: '', source: '' }]);
  return db;
}

const byId = (db, id) => db.Users.find((u) => u.user_id === id);

describe('migrateUsersToPasswordLogin', () => {
  it('gives every user a username and every column, but NO shared password', () => {
    const db = googleEraDb();
    const ctx = makeCtx();
    const changes = migrateUsersToPasswordLogin(db, ctx);
    assert.ok(changes.length > 0);

    assert.equal(byId(db, 'USR-0004').username, '2024000001'); // student number
    assert.equal(byId(db, 'USR-0005').username, '2024000004');
    assert.equal(byId(db, 'USR-0001').username, 'head.admin'); // email local part, lowercase
    assert.equal(byId(db, 'USR-0002').username, 'ana');
    assert.equal(byId(db, 'USR-0003').username, 'ana2'); // de-duplicated
    assert.equal(byId(db, 'USR-0006').username, 'usr-0006'); // no email: from user_id

    for (const user of db.Users) {
      assert.deepEqual(Object.keys(user).sort(), [...USER_COLUMNS].sort(), user.user_id);
      assert.equal(user.failed_attempts, '0');
      assert.equal(user.password_hash, ''); // an admin must reset them (temporary password)
    }
    assert.equal(byId(db, 'USR-0003').account_status, 'disabled'); // status untouched
  });

  it('removes google_sub and fixes the Settings rows', () => {
    const db = googleEraDb();
    migrateUsersToPasswordLogin(db, makeCtx());
    assert.ok(db.Users.every((u) => !('google_sub' in u)));
    const keys = db.Settings.map((s) => s.key);
    assert.ok(!keys.includes('allowed_email_rule'));
    assert.equal(db.Settings.find((s) => s.key === 'max_login_attempts').value, '5');
    assert.equal(db.Settings.find((s) => s.key === 'lockout_minutes').value, '15');
    assert.equal(db.Settings.find((s) => s.key === 'temp_password_days').value, '7');
  });

  it('logs what it changed, never a password', () => {
    const db = googleEraDb();
    const text = migrateUsersToPasswordLogin(db, makeCtx()).join('\n');
    assert.match(text, /USR-0003.*username.*ana2/);
    assert.match(text, /google_sub/);
    for (const secret of [...Object.values(TEST_PROPS), 'v1$']) assert.ok(!text.includes(secret), secret);
  });

  it('is idempotent: running it twice changes nothing the second time', () => {
    const db = googleEraDb();
    const ctx = makeCtx();
    migrateUsersToPasswordLogin(db, ctx);
    const after = JSON.stringify(db);
    assert.deepEqual(migrateUsersToPasswordLogin(db, ctx), []);
    assert.equal(JSON.stringify(db), after);
  });

  it('signs out old sessions (e.g. from the test sign-in) of users without a password', () => {
    const db = googleEraDb();
    db.AuthSessions = [
      { token_hash: 'a', user_id: 'USR-0001', created_at: '', expires_at: '2099-01-01T00:00:00+08:00', revoked: 'FALSE' },
      { token_hash: 'b', user_id: 'USR-0004', created_at: '', expires_at: '2099-01-01T00:00:00+08:00', revoked: 'FALSE' },
    ];
    const changes = migrateUsersToPasswordLogin(db, makeCtx());
    assert.ok(db.AuthSessions.every((s) => s.revoked === 'TRUE'));
    assert.match(changes.join('\n'), /USR-0001: 1 old session\(s\) signed out/);
  });

  it('keeps passwords and usernames that already exist', () => {
    const db = googleEraDb();
    const ctx = makeCtx();
    migrateUsersToPasswordLogin(db, ctx);
    const ana = byId(db, 'USR-0002');
    ana.password_hash = ctx.hash('AnaOwn123');
    ana.must_change_password = 'FALSE';
    ana.username = 'ana.reyes';
    db.Users.push({ user_id: 'USR-0007', email: 'ana.reyes@x.com', role: 'admin', linked_id: '', account_status: 'active' });
    migrateUsersToPasswordLogin(db, ctx);
    assert.ok(ctx.verify('AnaOwn123', ana.password_hash));
    assert.equal(ana.must_change_password, 'FALSE');
    assert.equal(byId(db, 'USR-0007').username, 'ana.reyes2');
  });

  it('migrated users without a password cannot sign in until an admin resets them', () => {
    const db = googleEraDb();
    const ctx = makeCtx();
    migrateUsersToPasswordLogin(db, ctx);
    const login = (password) => runAction(db, { action: 'auth.login', username: '2024000001', password }, ctx);
    assert.throws(() => login(''), withCode('INVALID_CREDENTIALS'));
    const { temp_password: temp } = resetPassword(db, { user_id: 'USR-0004' }, { user_id: 'USR-0001', role: 'admin' }, ctx);
    assert.equal(login(temp).must_change_password, true);
  });
});

describe('createBootstrapAdmin', () => {
  const props = (extra) => ({ ...TEST_PROPS, BOOTSTRAP_ADMIN_USERNAME: ' Root.Admin ', BOOTSTRAP_ADMIN_PASSWORD: 'FirstLogin2026', ...extra });

  function noAdminDb() {
    const db = makeDb();
    db.Users = db.Users.filter((u) => u.role !== 'admin');
    return db;
  }

  it('creates an active admin from the Script Properties, with must_change TRUE', () => {
    const db = noAdminDb();
    const ctx = makeCtx({ props: props() });
    const result = createBootstrapAdmin(db, ctx);
    const user = byId(db, result.user_id);
    assert.equal(user.username, 'root.admin');
    assert.equal(user.role, 'admin');
    assert.equal(user.must_change_password, 'TRUE');
    assert.ok(ctx.verify('FirstLogin2026', user.password_hash));
    assert.ok(!JSON.stringify(result).includes('FirstLogin2026'));
    assert.equal(db.AuditLog.at(-1).action, 'BOOTSTRAP_ADMIN');
  });

  it('refuses when an active admin already exists', () => {
    const db = makeDb();
    assert.throws(() => createBootstrapAdmin(db, makeCtx({ props: props() })), withCode('ADMIN_EXISTS'));
  });

  it('works when the only admin is disabled', () => {
    const db = makeDb();
    byId(db, 'USR-0001').account_status = 'disabled';
    assert.ok(createBootstrapAdmin(db, makeCtx({ props: props({ BOOTSTRAP_ADMIN_USERNAME: 'rescue' }) })).user_id);
  });

  it('needs both properties, a valid free username and a strong password', () => {
    assert.throws(() => createBootstrapAdmin(noAdminDb(), makeCtx({ props: props({ BOOTSTRAP_ADMIN_PASSWORD: '' }) })), withCode('NOT_CONFIGURED'));
    assert.throws(() => createBootstrapAdmin(noAdminDb(), makeCtx({ props: props({ BOOTSTRAP_ADMIN_USERNAME: '' }) })), withCode('NOT_CONFIGURED'));
    assert.throws(() => createBootstrapAdmin(noAdminDb(), makeCtx({ props: props({ BOOTSTRAP_ADMIN_USERNAME: 'ana' }) })), withCode('VALIDATION_ERROR'));
    assert.throws(() => createBootstrapAdmin(noAdminDb(), makeCtx({ props: props({ BOOTSTRAP_ADMIN_PASSWORD: 'password' }) })), withCode('VALIDATION_ERROR'));
  });
});

describe('seed data (FAKE, for a TEST Sheet)', () => {
  const seed = JSON.parse(readFileSync(new URL('../seed/seed-data.json', import.meta.url), 'utf8'));

  it('contains no passwords, hashes or google_sub', () => {
    const text = JSON.stringify(seed);
    assert.ok(!text.includes('google_sub'));
    assert.ok(!text.includes('v1$'));
    assert.ok(seed.Users.every((u) => u.password_hash === ''));
    assert.ok(!seed.Settings.some((s) => s.key === 'allowed_email_rule'));
  });

  it('Users have every column, unique usernames, students = student numbers', () => {
    const numbers = new Map(seed.Students.map((s) => [s.student_id, s.student_number]));
    seed.Users.forEach((u) => assert.deepEqual(Object.keys(u), [...USER_COLUMNS], u.user_id));
    assert.equal(new Set(seed.Users.map((u) => u.username)).size, seed.Users.length);
    seed.Users.filter((u) => u.role === 'student').forEach((u) => assert.equal(u.username, numbers.get(u.linked_id)));
  });

  it('has the login settings', () => {
    const value = (key) => seed.Settings.find((s) => s.key === key)?.value;
    assert.equal(value('max_login_attempts'), '5');
    assert.equal(value('lockout_minutes'), '15');
  });

  it('has temp_password_days = 7', () => {
    assert.equal(seed.Settings.find((s) => s.key === 'temp_password_days')?.value, '7');
  });

  it('seedTestPasswords gives the FAKE users TEST_SEED_PASSWORD, must change, nothing else', () => {
    const db = JSON.parse(JSON.stringify(seed));
    const ctx = makeCtx();
    const lines = seedTestPasswords(db, ctx);
    assert.ok(!lines.join(' ').includes(TEST_PROPS.TEST_SEED_PASSWORD));
    db.Users.forEach((u, i) => {
      assert.equal(u.username, seed.Users[i].username);
      assert.equal(u.must_change_password, 'TRUE');
      assert.ok(ctx.verify(TEST_PROPS.TEST_SEED_PASSWORD, u.password_hash));
    });
    assert.deepEqual(seedTestPasswords(db, ctx), ['0 test user(s) got the TEST_SEED_PASSWORD (must change at first sign-in).']);
  });

  it('seedTestPasswords stops with NOT_CONFIGURED when TEST_SEED_PASSWORD is missing', () => {
    const db = JSON.parse(JSON.stringify(seed));
    const before = JSON.stringify(db);
    assert.throws(() => seedTestPasswords(db, makeCtx({ props: { PASSWORD_PEPPER: 'p' } })), withCode('NOT_CONFIGURED'));
    assert.equal(JSON.stringify(db), before);
  });
});
