// Random temporary passwords per user (replaces the shared per-role default).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, SESSIONS, withCode } from './helpers/db.js';
import { makeCtx, nodeCrypto, TEST_PEPPER } from './helpers/auth.js';
import { runAction } from '../src/actions.js';
import { generateTempPassword, TEMP_PASSWORD_PATTERN, hashPassword } from '../src/auth/passwords.js';
import { resetPassword } from '../src/auth/admin-users.js';
import { createStudent } from '../src/handlers/students.js';
import { createInstructor } from '../src/handlers/instructors.js';
import { createAdmin } from '../src/handlers/admins.js';

const DAY = 24 * 60 * 60000;
const newStudent = (extra = {}) => ({ student_number: '2024000010', first_name: 'Gino', last_name: 'Dela Cruz', section_id: 'SEC-0001', ...extra });
const userOfLinked = (db, linked) => db.Users.find((u) => u.linked_id === linked);
const login = (db, ctx, username, password) => runAction(db, { action: 'auth.login', username, password }, ctx);
const call = (db, ctx, action, token, extra = {}) => runAction(db, { action, session_token: token, ...extra }, ctx);

describe('generateTempPassword', () => {
  it('is 10 unambiguous characters shown as two groups of 5', () => {
    assert.equal(String(TEMP_PASSWORD_PATTERN), String(/^[2-9A-HJ-NP-Za-km-np-z]{5}-[2-9A-HJ-NP-Za-km-np-z]{5}$/));
    const seen = new Set();
    for (let i = 0; i < 500; i += 1) {
      const value = generateTempPassword(nodeCrypto);
      assert.match(value, TEMP_PASSWORD_PATTERN);
      assert.doesNotMatch(value, /[01OoIl]/);
      seen.add(value);
    }
    assert.equal(seen.size, 500);
  });

  it('takes its randomness only from crypto.randomHex', () => {
    const fixed = { ...nodeCrypto, randomHex: (n) => '00'.repeat(n) }; // byte 0 -> first alphabet char
    assert.equal(generateTempPassword(fixed), '22222-22222');
  });
});

describe('creating accounts issues a temporary password', () => {
  it('two created users get different temp passwords, returned once, stored only as a hash', () => {
    const db = makeDb();
    const ctx = makeCtx();
    const a = createStudent(db, newStudent(), SESSIONS.admin, ctx);
    const b = createInstructor(db, { username: 'carlo.d', first_name: 'Carlo', last_name: 'Diaz', department: 'CpE' }, SESSIONS.admin, ctx);
    const c = createAdmin(db, { username: 'registrar', display_name: 'Registrar' }, SESSIONS.admin, ctx);
    for (const result of [a, b, c]) assert.match(result.temp_password, TEMP_PASSWORD_PATTERN);
    assert.equal(new Set([a, b, c].map((r) => r.temp_password)).size, 3);

    const user = userOfLinked(db, a.student_id);
    assert.equal(user.must_change_password, 'TRUE');
    assert.ok(user.password_hash.startsWith('v1$300$'));
    assert.ok(ctx.verify(a.temp_password.replace('-', ''), user.password_hash)); // dash is display-only
    assert.equal(user.temp_password_expires_at, '2026-11-25T08:00:00+08:00'); // fake now 2026-11-18 08:00 Manila + 7 days
    assert.equal(a.temp_password_expires_at, user.temp_password_expires_at);
  });

  it('uses the temp_password_days setting', () => {
    const db = makeDb();
    db.Settings.push({ key: 'temp_password_days', value: '2', description: '', source: '' });
    const { temp_password_expires_at: expires } = createStudent(db, newStudent(), SESSIONS.admin, makeCtx());
    assert.equal(expires, '2026-11-20T08:00:00+08:00');
  });

  it('NOT_CONFIGURED without a pepper, and nothing changes', () => {
    const db = makeDb();
    const before = JSON.stringify(db);
    assert.throws(() => createStudent(db, newStudent(), SESSIONS.admin, makeCtx({ props: {} })), withCode('NOT_CONFIGURED'));
    assert.equal(JSON.stringify(db), before);
  });
});

describe('signing in with a temporary password', () => {
  function created() {
    const db = makeDb();
    const ctx = makeCtx();
    const { temp_password: temp } = createStudent(db, newStudent(), SESSIONS.admin, ctx);
    return { db, ctx, temp, user: db.Users.at(-1) };
  }

  it('works, but must_change blocks every other action', () => {
    const { db, ctx, temp } = created();
    const data = login(db, ctx, '2024000010', temp);
    assert.equal(data.must_change_password, true);
    assert.throws(() => call(db, ctx, 'student.getOverview', data.session_token), withCode('PASSWORD_CHANGE_REQUIRED'));
    assert.equal(call(db, ctx, 'auth.me', data.session_token).must_change_password, true);
  });

  it('after 7 days: TEMP_PASSWORD_EXPIRED (fake clock), saved, not counted as a failure', () => {
    const { db, ctx, temp, user } = created();
    ctx.clock.ms += 7 * DAY - 1;
    assert.ok(login(db, ctx, '2024000010', temp).session_token); // still valid 1 ms before
    ctx.clock.ms += 1;
    let error = null;
    try { login(db, ctx, '2024000010', temp); } catch (e) { error = e; }
    assert.equal(error.code, 'TEMP_PASSWORD_EXPIRED');
    assert.match(error.message, /Ask the admin to reset your password/);
    assert.equal(error.commit, true);
    assert.equal(user.failed_attempts, '0');
    assert.equal(db.AuditLog.at(-1).action, 'LOGIN_FAILED');
  });

  it('a wrong password after expiry is still INVALID_CREDENTIALS (expiry is not revealed)', () => {
    const { db, ctx } = created();
    ctx.clock.ms += 8 * DAY;
    assert.throws(() => login(db, ctx, '2024000010', 'Wrong12345'), withCode('INVALID_CREDENTIALS'));
  });

  it('changing the password clears temp_password_expires_at; old temp stops working', () => {
    const { db, ctx, temp, user } = created();
    const { session_token: token } = login(db, ctx, '2024000010', temp);
    call(db, ctx, 'auth.changePassword', token, { old_password: temp, new_password: 'MyOwnPass99' });
    assert.equal(user.temp_password_expires_at, '');
    assert.equal(user.must_change_password, 'FALSE');
    ctx.clock.ms += 30 * DAY; // own passwords never expire
    assert.ok(login(db, ctx, '2024000010', 'MyOwnPass99').session_token);
    assert.throws(() => login(db, ctx, '2024000010', temp), withCode('INVALID_CREDENTIALS'));
  });

  it('the new password must differ from the current (temporary) one', () => {
    const db = makeDb();
    const ctx = makeCtx();
    createStudent(db, newStudent(), SESSIONS.admin, ctx);
    db.Users.at(-1).password_hash = ctx.hash('Abcde23456'); // a known temp value (stored without the dash)
    const { session_token: token } = login(db, ctx, '2024000010', 'Abcde-23456');
    for (const again of ['Abcde-23456', 'Abcde23456']) {
      assert.throws(() => call(db, ctx, 'auth.changePassword', token, { old_password: 'Abcde-23456', new_password: again }),
        (e) => withCode('VALIDATION_ERROR')(e) && /current/.test(e.fields.new_password));
    }
  });
});

describe('the dash (and spaces) in a temporary password are optional', () => {
  function created() {
    const db = makeDb();
    const ctx = makeCtx();
    const { temp_password: temp } = createStudent(db, newStudent(), SESSIONS.admin, ctx);
    return { db, ctx, temp, user: db.Users.at(-1) };
  }

  it('is hashed without the dash; the response still shows it with the dash', () => {
    const { ctx, temp, user } = created();
    assert.match(temp, TEMP_PASSWORD_PATTERN);
    assert.ok(ctx.verify(temp.replace('-', ''), user.password_hash));
    assert.ok(!ctx.verify(temp, user.password_hash));
  });

  for (const [label, typed] of [
    ['with the dash', (t) => t],
    ['without the dash', (t) => t.replace('-', '')],
    ['with spaces instead of the dash', (t) => ` ${t.replace('-', ' ')} `],
    ['with spaces and the dash', (t) => t.replace('-', ' - ')],
  ]) {
    it(`signs in ${label}`, () => {
      const { db, ctx, temp } = created();
      assert.equal(login(db, ctx, '2024000010', typed(temp)).must_change_password, true);
    });
  }

  it('the current (temporary) password in changePassword may also be typed without the dash', () => {
    const { db, ctx, temp, user } = created();
    const { session_token: token } = login(db, ctx, '2024000010', temp);
    call(db, ctx, 'auth.changePassword', token, { old_password: temp.replace('-', ''), new_password: 'MyOwnPass99' });
    assert.equal(user.must_change_password, 'FALSE');
  });

  it('a wrong temporary password still counts as a failed attempt', () => {
    const { db, ctx, temp, user } = created();
    const wrong = `${temp.slice(0, -1)}${temp.endsWith('2') ? '3' : '2'}`;
    assert.throws(() => login(db, ctx, '2024000010', wrong), withCode('INVALID_CREDENTIALS'));
    assert.equal(user.failed_attempts, '1');
  });

  it('a user-chosen password containing "-" or spaces is compared exactly (no stripping)', () => {
    const { db, ctx, temp } = created();
    const { session_token: token } = login(db, ctx, '2024000010', temp);
    call(db, ctx, 'auth.changePassword', token, { old_password: temp, new_password: 'My-Pass 99' });
    assert.throws(() => login(db, ctx, '2024000010', 'MyPass99'), withCode('INVALID_CREDENTIALS'));
    assert.throws(() => login(db, ctx, '2024000010', 'My-Pass99'), withCode('INVALID_CREDENTIALS'));
    assert.ok(login(db, ctx, '2024000010', 'My-Pass 99').session_token);
  });
});

describe('admin.resetPassword issues a new temporary password', () => {
  it('returns a new one; the old one stops working; expiry restarts', () => {
    const db = makeDb();
    const ctx = makeCtx();
    const { temp_password: first } = createStudent(db, newStudent(), SESSIONS.admin, ctx);
    const user = db.Users.at(-1);
    ctx.clock.ms += 10 * DAY; // first one expired
    const result = resetPassword(db, { user_id: user.user_id }, SESSIONS.admin, ctx);
    assert.match(result.temp_password, TEMP_PASSWORD_PATTERN);
    assert.notEqual(result.temp_password, first);
    assert.equal(result.must_change_password, true);
    assert.equal(user.temp_password_expires_at, '2026-12-05T08:00:00+08:00');
    assert.throws(() => login(db, ctx, '2024000010', first), withCode('INVALID_CREDENTIALS'));
    assert.equal(login(db, ctx, '2024000010', result.temp_password).must_change_password, true);
  });
});

describe('the temporary password never leaks', () => {
  it('appears in no Sheet row, no AuditLog row and no response except create/reset', () => {
    const db = makeDb();
    const ctx = makeCtx();
    setPasswordOf(db, ctx, 'USR-0001', 'AdminPass1');
    const admin = login(db, ctx, 'admin', 'AdminPass1').session_token;

    const created = call(db, ctx, 'admin.createStudent', admin, newStudent());
    const reset = call(db, ctx, 'admin.resetPassword', admin, { user_id: db.Users.at(-1).user_id });
    const secrets = [created.temp_password, reset.temp_password];
    secrets.forEach((s) => assert.match(s, TEMP_PASSWORD_PATTERN));

    const responses = [
      call(db, ctx, 'admin.listStudents', admin),
      call(db, ctx, 'admin.getStudent', admin, { student_id: created.student_id }),
    ];
    const student = login(db, ctx, '2024000010', reset.temp_password);
    responses.push(student, call(db, ctx, 'auth.me', student.session_token));
    responses.push(call(db, ctx, 'auth.changePassword', student.session_token, { old_password: reset.temp_password, new_password: 'MyOwnPass99' }));

    const everything = JSON.stringify(db) + JSON.stringify(responses);
    for (const secret of secrets) {
      assert.ok(!everything.includes(secret), 'temp password leaked');
      assert.ok(!everything.includes(secret.replace('-', '')), 'temp password leaked');
    }
    assert.ok(db.AuditLog.some((r) => r.action === 'PASSWORD_RESET'));
    assert.ok(db.AuditLog.some((r) => r.action === 'STUDENT_CREATE'));
  });
});

describe('existing hashes keep working (no migration)', () => {
  it('an old seeded hash (no temp_password_expires_at column) still signs in', () => {
    const db = makeDb();
    const ctx = makeCtx();
    const user = db.Users.find((u) => u.user_id === 'USR-0002');
    user.password_hash = hashPassword(nodeCrypto, TEST_PEPPER, 'SeedPass123', 1500); // older iteration count too
    user.must_change_password = 'TRUE';
    assert.equal('temp_password_expires_at' in user, false);
    ctx.clock.ms += 365 * DAY;
    assert.equal(login(db, ctx, 'ana', 'SeedPass123').must_change_password, true);
  });
});

function setPasswordOf(db, ctx, userId, password) {
  const user = db.Users.find((u) => u.user_id === userId);
  user.password_hash = ctx.hash(password);
  user.must_change_password = 'FALSE';
}
