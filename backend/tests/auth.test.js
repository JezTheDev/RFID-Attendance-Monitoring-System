// auth.login / auth.me / auth.changePassword / auth.logout and the request gate
// (runAction): sessions, roles, lockout, forced password change.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, withCode } from './helpers/db.js';
import { makeCtx, setPassword, errorOf, TEST_PROPS } from './helpers/auth.js';
import { runAction } from '../src/actions.js';
import { PASSWORD_HASH_ITERATIONS, hashPassword, hashIterations } from '../src/auth/passwords.js';
import { nodeCrypto, TEST_PEPPER } from './helpers/auth.js';

const MIN = 60000;
const ANA_PW = 'AnaPass123';

function setup({ mustChange = false } = {}) {
  const db = makeDb();
  const ctx = makeCtx();
  setPassword(db, ctx, 'USR-0002', ANA_PW, { mustChange });
  return { db, ctx };
}

const login = (db, ctx, username, password) => runAction(db, { action: 'auth.login', username, password }, ctx);
const call = (db, ctx, action, token, extra = {}) => runAction(db, { action, session_token: token, ...extra }, ctx);
const ana = (db) => db.Users.find((u) => u.user_id === 'USR-0002');
const audits = (db, action) => db.AuditLog.filter((row) => row.action === action);

describe('auth.login', () => {
  it('signs in with username + password and returns role, display_name, must_change_password', () => {
    const { db, ctx } = setup();
    const data = login(db, ctx, 'ana', ANA_PW);
    assert.equal(data.role, 'instructor');
    assert.equal(data.display_name, 'Ana Reyes');
    assert.equal(data.username, 'ana');
    assert.equal(data.must_change_password, false);
    assert.match(data.session_token, /^[0-9a-f]{64}$/);
    assert.equal(db.AuthSessions.length, 1);
    assert.notEqual(db.AuthSessions[0].token_hash, data.session_token); // only the hash is stored
    assert.equal(call(db, ctx, 'auth.me', data.session_token).user_id, 'USR-0002');
    assert.equal(audits(db, 'LOGIN_SUCCESS').length, 1);
    assert.ok(ana(db).last_login_at.endsWith('+08:00'));
  });

  it('ignores surrounding spaces and upper case in the username', () => {
    const { db, ctx } = setup();
    assert.equal(login(db, ctx, '  ANA ', ANA_PW).user_id, 'USR-0002');
  });

  it('gives the SAME error for an unknown username and a wrong password', () => {
    const { db, ctx } = setup();
    const unknown = errorOf(() => login(db, ctx, 'nobody', ANA_PW));
    const wrong = errorOf(() => login(db, ctx, 'ana', 'WrongPass1'));
    assert.equal(unknown.code, 'INVALID_CREDENTIALS');
    assert.deepEqual({ code: unknown.code, message: unknown.message, fields: unknown.fields },
      { code: wrong.code, message: wrong.message, fields: wrong.fields });
  });

  it('marks failed logins to be saved (commit) and audits them without the attempted text', () => {
    const { db, ctx } = setup();
    const unknown = errorOf(() => login(db, ctx, 'nobody-typed-Secret99', 'x'));
    const wrong = errorOf(() => login(db, ctx, 'ana', 'WrongPass1'));
    assert.equal(unknown.commit, true);
    assert.equal(wrong.commit, true);
    assert.equal(ana(db).failed_attempts, '1');
    const failed = audits(db, 'LOGIN_FAILED');
    assert.equal(failed.length, 2);
    assert.equal(failed[0].entity_id, '');
    assert.equal(failed[1].entity_id, 'USR-0002');
    assert.ok(!JSON.stringify(db.AuditLog).includes('Secret99'));
    assert.ok(!JSON.stringify(db.AuditLog).includes('WrongPass1'));
  });

  it('rejects an empty username or password with the generic error', () => {
    const { db, ctx } = setup();
    assert.throws(() => login(db, ctx, '', ANA_PW), withCode('INVALID_CREDENTIALS'));
    assert.throws(() => login(db, ctx, 'ana', ''), withCode('INVALID_CREDENTIALS'));
  });

  it('locks the account for 15 minutes after 5 wrong passwords, then lets the right one in', () => {
    const { db, ctx } = setup();
    for (let i = 1; i <= 4; i += 1) assert.throws(() => login(db, ctx, 'ana', 'WrongPass1'), withCode('INVALID_CREDENTIALS'));
    const fifth = errorOf(() => login(db, ctx, 'ana', 'WrongPass1'));
    assert.equal(fifth.code, 'ACCOUNT_LOCKED');
    assert.equal(fifth.commit, true);
    assert.equal(ana(db).failed_attempts, '5');
    assert.equal(Date.parse(ana(db).locked_until), ctx.clock.ms + 15 * MIN);
    assert.ok(ana(db).locked_until.endsWith('+08:00'));
    assert.equal(audits(db, 'ACCOUNT_LOCKED').length, 1);

    // Still locked: even the right password is refused (and not checked).
    ctx.clock.ms += 14 * MIN;
    assert.throws(() => login(db, ctx, 'ana', ANA_PW), withCode('ACCOUNT_LOCKED'));

    ctx.clock.ms += 1 * MIN; // exactly locked_until
    assert.equal(login(db, ctx, 'ana', ANA_PW).user_id, 'USR-0002');
    assert.equal(ana(db).failed_attempts, '0');
    assert.equal(ana(db).locked_until, '');
  });

  it('starts counting again from 0 after a lock expires', () => {
    const { db, ctx } = setup();
    for (let i = 0; i < 5; i += 1) errorOf(() => login(db, ctx, 'ana', 'WrongPass1'));
    ctx.clock.ms += 16 * MIN;
    assert.throws(() => login(db, ctx, 'ana', 'WrongPass1'), withCode('INVALID_CREDENTIALS'));
    assert.equal(ana(db).failed_attempts, '1');
    assert.equal(ana(db).locked_until, '');
  });

  it('a successful login resets the failure counter', () => {
    const { db, ctx } = setup();
    for (let i = 0; i < 3; i += 1) errorOf(() => login(db, ctx, 'ana', 'WrongPass1'));
    login(db, ctx, 'ana', ANA_PW);
    assert.equal(ana(db).failed_attempts, '0');
  });

  it('uses max_login_attempts and lockout_minutes from Settings', () => {
    const { db, ctx } = setup();
    db.Settings.find((s) => s.key === 'max_login_attempts').value = '2';
    db.Settings.find((s) => s.key === 'lockout_minutes').value = '30';
    errorOf(() => login(db, ctx, 'ana', 'WrongPass1'));
    assert.throws(() => login(db, ctx, 'ana', 'WrongPass1'), withCode('ACCOUNT_LOCKED'));
    assert.equal(Date.parse(ana(db).locked_until), ctx.clock.ms + 30 * MIN);
  });

  it('rejects a disabled account (only with the right password does it say "disabled")', () => {
    const { db, ctx } = setup();
    ana(db).account_status = 'disabled';
    assert.throws(() => login(db, ctx, 'ana', ANA_PW), withCode('ACCOUNT_DISABLED'));
    assert.throws(() => login(db, ctx, 'ana', 'WrongPass1'), withCode('INVALID_CREDENTIALS'));
    assert.equal(db.AuthSessions.length, 0);
  });

  it('rejects a user who has no password yet with the generic error', () => {
    const { db, ctx } = setup();
    assert.throws(() => login(db, ctx, 'ben', ''), withCode('INVALID_CREDENTIALS'));
    assert.throws(() => login(db, ctx, 'ben', 'Anything1'), withCode('INVALID_CREDENTIALS'));
  });

  it('fails clearly when PASSWORD_PEPPER is not set, and saves nothing', () => {
    const db = makeDb();
    const ctx = makeCtx({ props: { ...TEST_PROPS, PASSWORD_PEPPER: '' } });
    const error = errorOf(() => login(db, ctx, 'ana', ANA_PW));
    assert.equal(error.code, 'NOT_CONFIGURED');
    assert.notEqual(error.commit, true);
  });

  it('re-hashes a password stored with fewer iterations than the current constant', () => {
    const { db, ctx } = setup();
    ana(db).password_hash = hashPassword(nodeCrypto, TEST_PEPPER, ANA_PW, 3);
    login(db, ctx, 'ana', ANA_PW);
    assert.equal(hashIterations(ana(db).password_hash), PASSWORD_HASH_ITERATIONS);
    assert.equal(login(db, ctx, 'ana', ANA_PW).user_id, 'USR-0002');
  });

  it('still accepts a hash made with the old 1500-iteration constant', () => {
    const { db, ctx } = setup();
    ana(db).password_hash = hashPassword(nodeCrypto, TEST_PEPPER, ANA_PW, 1500);
    assert.equal(login(db, ctx, 'ana', ANA_PW).user_id, 'USR-0002');
    assert.throws(() => login(db, ctx, 'ana', 'WrongPass1'), withCode('INVALID_CREDENTIALS'));
  });
});

describe('sessions and roles (runAction)', () => {
  it('rejects unknown actions, missing tokens and expired sessions', () => {
    const { db, ctx } = setup();
    assert.throws(() => call(db, ctx, 'auth.google', null), withCode('UNKNOWN_ACTION'));
    assert.throws(() => call(db, ctx, 'auth.testSignIn', null), withCode('UNKNOWN_ACTION'));
    assert.throws(() => call(db, ctx, 'toString', null), withCode('UNKNOWN_ACTION'));
    assert.throws(() => call(db, ctx, 'auth.me', null), withCode('NOT_SIGNED_IN'));
    assert.throws(() => call(db, ctx, 'auth.me', 'not-a-real-token'), withCode('NOT_SIGNED_IN'));
    const { session_token: token } = login(db, ctx, 'ana', ANA_PW);
    ctx.clock.ms += 8 * 60 * MIN;
    assert.throws(() => call(db, ctx, 'auth.me', token), withCode('NOT_SIGNED_IN'));
  });

  it('enforces the role of each action on the server', () => {
    const { db, ctx } = setup();
    const { session_token: token } = login(db, ctx, 'ana', ANA_PW);
    assert.throws(() => call(db, ctx, 'admin.listStudents', token), withCode('FORBIDDEN'));
    assert.throws(() => call(db, ctx, 'student.getOverview', token), withCode('FORBIDDEN'));
    assert.ok(call(db, ctx, 'instructor.getClassRoster', token, { class_id: 'CLS-0001' }));
  });

  it('a disabled user is signed out on the next request', () => {
    const { db, ctx } = setup();
    const { session_token: token } = login(db, ctx, 'ana', ANA_PW);
    ana(db).account_status = 'disabled';
    assert.throws(() => call(db, ctx, 'auth.me', token), withCode('NOT_SIGNED_IN'));
  });

  it('auth.logout revokes the token; without a token it does nothing', () => {
    const { db, ctx } = setup();
    const { session_token: token } = login(db, ctx, 'ana', ANA_PW);
    assert.deepEqual(call(db, ctx, 'auth.logout', token), {});
    assert.throws(() => call(db, ctx, 'auth.me', token), withCode('NOT_SIGNED_IN'));
    assert.deepEqual(call(db, ctx, 'auth.logout', null), {});
  });

  it('auth.me returns the current user (no secrets)', () => {
    const { db, ctx } = setup();
    const { session_token: token } = login(db, ctx, 'ana', ANA_PW);
    const me = call(db, ctx, 'auth.me', token);
    assert.deepEqual(Object.keys(me).sort(),
      ['display_name', 'email', 'expires_at', 'last_login_at', 'must_change_password', 'role', 'user_id', 'username']);
    assert.equal(me.display_name, 'Ana Reyes');
  });
});

describe('must_change_password gate', () => {
  it('blocks every other action with PASSWORD_CHANGE_REQUIRED until the password is changed', () => {
    const { db, ctx } = setup({ mustChange: true });
    const data = login(db, ctx, 'ana', ANA_PW);
    assert.equal(data.must_change_password, true);
    const token = data.session_token;
    assert.throws(() => call(db, ctx, 'instructor.getClassRoster', token, { class_id: 'CLS-0001' }), withCode('PASSWORD_CHANGE_REQUIRED'));
    assert.equal(call(db, ctx, 'auth.me', token).must_change_password, true);

    call(db, ctx, 'auth.changePassword', token, { old_password: ANA_PW, new_password: 'NewPass456' });
    assert.ok(call(db, ctx, 'instructor.getClassRoster', token, { class_id: 'CLS-0001' }));
    assert.equal(ana(db).must_change_password, 'FALSE');
  });

  it('still allows auth.logout', () => {
    const { db, ctx } = setup({ mustChange: true });
    const { session_token: token } = login(db, ctx, 'ana', ANA_PW);
    assert.deepEqual(call(db, ctx, 'auth.logout', token), {});
  });
});

describe('auth.changePassword', () => {
  const change = (db, ctx, token, oldPw, newPw) => call(db, ctx, 'auth.changePassword', token, { old_password: oldPw, new_password: newPw });
  const fieldError = (field) => (error) => withCode('VALIDATION_ERROR')(error) && Boolean(error.fields?.[field]);

  it('enforces the new-password rules and keeps the old hash when they fail', () => {
    const { db, ctx } = setup();
    const { session_token: token } = login(db, ctx, 'ana', ANA_PW);
    const before = ana(db).password_hash;
    assert.throws(() => change(db, ctx, token, 'WrongOld1', 'NewPass456'), fieldError('old_password'));
    assert.throws(() => change(db, ctx, token, ANA_PW, 'Short1'), fieldError('new_password'));
    assert.throws(() => change(db, ctx, token, ANA_PW, 'lettersonly'), fieldError('new_password'));
    assert.throws(() => change(db, ctx, token, ANA_PW, '1234567890'), fieldError('new_password'));
    assert.throws(() => change(db, ctx, token, ANA_PW, ANA_PW), fieldError('new_password'));
    assert.throws(() => change(db, ctx, token, ANA_PW, `A1${'x'.repeat(127)}`), fieldError('new_password'));
    assert.equal(ana(db).password_hash, before);
  });

  it('a wrong old password does not count toward the login lockout', () => {
    const { db, ctx } = setup();
    const { session_token: token } = login(db, ctx, 'ana', ANA_PW);
    for (let i = 0; i < 6; i += 1) errorOf(() => change(db, ctx, token, 'WrongOld1', 'NewPass456'));
    assert.equal(ana(db).failed_attempts, '0');
  });

  it('saves the new password, clears must_change and revokes only the OTHER sessions', () => {
    const { db, ctx } = setup({ mustChange: true });
    const first = login(db, ctx, 'ana', ANA_PW).session_token;
    const second = login(db, ctx, 'ana', ANA_PW).session_token;
    const result = change(db, ctx, second, ANA_PW, 'NewPass456');
    assert.equal(result.must_change_password, false);
    assert.equal(result.other_sessions_revoked, 1);
    assert.equal(ana(db).must_change_password, 'FALSE');
    assert.ok(ana(db).password_changed_at.endsWith('+08:00'));
    assert.throws(() => call(db, ctx, 'auth.me', first), withCode('NOT_SIGNED_IN'));
    assert.equal(call(db, ctx, 'auth.me', second).user_id, 'USR-0002');
    assert.throws(() => login(db, ctx, 'ana', ANA_PW), withCode('INVALID_CREDENTIALS'));
    assert.equal(login(db, ctx, 'ana', 'NewPass456').user_id, 'USR-0002');
    assert.equal(audits(db, 'PASSWORD_CHANGED').length, 1);
  });

  it('needs no DEFAULT_*_PASSWORD property (only the pepper)', () => {
    const db = makeDb();
    const ctx = makeCtx({ props: { PASSWORD_PEPPER: TEST_PROPS.PASSWORD_PEPPER } });
    setPassword(db, ctx, 'USR-0002', ANA_PW);
    const { session_token: token } = login(db, ctx, 'ana', ANA_PW);
    assert.equal(change(db, ctx, token, ANA_PW, 'NewPass456').must_change_password, false);
  });
});

describe('no secrets leave the server', () => {
  it('no response or audit row contains a password, a hash, or a token hash', () => {
    const { db, ctx } = setup({ mustChange: true });
    const responses = [];
    const record = (fn) => { try { responses.push(fn()); } catch (error) { responses.push({ code: error.code, message: error.message, fields: error.fields }); } };
    record(() => login(db, ctx, 'ana', 'WrongPass1'));
    record(() => login(db, ctx, 'nobody', ANA_PW));
    const data = login(db, ctx, 'ana', ANA_PW);
    responses.push(data);
    record(() => call(db, ctx, 'auth.me', data.session_token));
    record(() => call(db, ctx, 'auth.changePassword', data.session_token, { old_password: ANA_PW, new_password: 'NewPass456' }));
    record(() => call(db, ctx, 'auth.logout', data.session_token));

    const text = JSON.stringify(responses) + JSON.stringify(db.AuditLog);
    for (const secret of [ANA_PW, 'NewPass456', 'WrongPass1', 'password_hash', 'v1$', 'token_hash', db.AuthSessions[0].token_hash]) {
      assert.ok(!text.includes(secret), `leaked: ${secret}`);
    }
  });
});
