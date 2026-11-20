// createBootstrapAdmin, seedTestPasswords and the fake seed data.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDb, withCode } from './helpers/db.js';
import { makeCtx, TEST_PROPS } from './helpers/auth.js';
import { createBootstrapAdmin, seedTestPasswords } from '../src/auth/migration.js';
import { USER_COLUMNS } from '../src/auth/admin-users.js';

const byId = (db, id) => db.Users.find((u) => u.user_id === id);

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
