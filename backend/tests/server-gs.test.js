// Runs the REAL Server.gs + Bundle.gs + SeedData.gs inside a Node vm with a
// small fake of the Apps Script services (helpers/fake-apps-script.js). Checks the
// wiring that unit tests cannot: routing, saving failed logins, setupSheets,
// the editor-only jobs, and how many tabs/rows each request reads and writes.
// Run `node tools/build_apps_script.mjs` first.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, SEED, PROPS } from './helpers/fake-apps-script.js';

describe('Server.gs in a fake Apps Script', () => {
  it('setupSheets seeds users with TEST_SEED_PASSWORD hashes, no google_sub', () => {
    const { context, usersTab, logs } = makeServer();
    context.setupSheets();
    const users = usersTab();
    assert.ok(users.length > 0);
    assert.ok(users.every((u) => u.password_hash.startsWith('v1$') && u.must_change_password === 'TRUE'));
    assert.ok(!('google_sub' in users[0]));
    assert.ok(!logs.join('\n').includes(SEED));
  });

  it('setupSheets refuses to seed users without TEST_SEED_PASSWORD, before creating any tab', () => {
    const { context, ss } = makeServer({ PASSWORD_PEPPER: 'x' });
    assert.throws(() => context.setupSheets(), /TEST_SEED_PASSWORD/);
    assert.equal(ss.getSheets().length, 1);
  });

  it('Apps Script randomHex drops the fixed UUID version/variant digits (every hex position varies)', () => {
    const { context } = makeServer();
    const crypto = context.RFID.appsScriptCrypto();
    const samples = Array.from({ length: 300 }, () => crypto.randomHex(16));
    samples.forEach((hex) => assert.match(hex, /^[0-9a-f]{32}$/));
    for (let i = 0; i < 32; i += 1) assert.ok(new Set(samples.map((hex) => hex[i])).size > 4, `position ${i} is not random`);
  });

  it('setup needs only PASSWORD_PEPPER: DEFAULT_*_PASSWORD are not required', () => {
    const { context } = makeServer();
    assert.deepEqual(Array.from(context.REQUIRED_PROPERTIES), ['PASSWORD_PEPPER']);
  });

  it('checkSetup says leftover DEFAULT_*_PASSWORD properties are safe to delete', () => {
    const { context, logs } = makeServer({ ...PROPS, DEFAULT_STUDENT_PASSWORD: 'old1', DEFAULT_ADMIN_PASSWORD: 'old2' });
    context.setupSheets();
    logs.length = 0;
    context.checkSetup();
    const text = logs.join('\n');
    assert.match(text, /DEFAULT_STUDENT_PASSWORD .*safe to delete/);
    assert.match(text, /DEFAULT_ADMIN_PASSWORD .*safe to delete/);
    assert.doesNotMatch(text, /DEFAULT_INSTRUCTOR_PASSWORD/);
    assert.ok(!text.includes('old1') && !text.includes('old2'));
  });

  it('a temp password from create/reset over doPost is in the response only: no Sheet cell, no log', () => {
    const { context, post, ss, logs } = makeServer();
    context.setupSheets();
    const admin = post({ action: 'auth.login', username: 'admin.test', password: SEED }).data.session_token;
    post({ action: 'auth.changePassword', session_token: admin, old_password: SEED, new_password: 'NewAdmin99' });
    const created = post({ action: 'admin.createStudent', session_token: admin, student_number: '2024999001', first_name: 'Test', last_name: 'Person', section_id: 'SEC-0001' });
    assert.equal(created.ok, true, JSON.stringify(created.error));
    const users = ss.getSheetByName('Users').cells;
    const userId = users[users.length - 1][0];
    const reset = post({ action: 'admin.resetPassword', session_token: admin, user_id: userId });
    const secrets = [created.data.temp_password, reset.data.temp_password];
    secrets.forEach((t) => assert.match(t, /^[2-9A-HJ-NP-Za-km-np-z]{5}-[2-9A-HJ-NP-Za-km-np-z]{5}$/));
    const cells = JSON.stringify(ss.getSheets().map((sheet) => sheet.cells));
    for (const t of secrets) {
      assert.ok(!cells.includes(t) && !cells.includes(t.replace('-', '')), 'temp password in a Sheet cell');
      assert.ok(!logs.join('\n').includes(t), 'temp password in a log');
    }
    assert.equal(post({ action: 'auth.login', username: '2024999001', password: reset.data.temp_password }).data.must_change_password, true);
    assert.equal(post({ action: 'auth.login', username: '2024999001', password: created.data.temp_password }).error.code, 'INVALID_CREDENTIALS');
  });

  it('full login flow over doPost: login, gate, failed attempt saved, change password', () => {
    const { context, post, usersTab } = makeServer();
    context.setupSheets();
    const student = usersTab().find((u) => u.role === 'student');

    const wrong = post({ action: 'auth.login', username: student.username, password: 'Nope12345' });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error.code, 'INVALID_CREDENTIALS');
    assert.equal(usersTab().find((u) => u.user_id === student.user_id).failed_attempts, '1'); // saved despite the error

    const login = post({ action: 'auth.login', username: student.username, password: SEED });
    assert.equal(login.ok, true);
    assert.equal(login.data.must_change_password, true);
    const token = login.data.session_token;

    const blocked = post({ action: 'student.getOverview', session_token: token });
    assert.equal(blocked.error.code, 'PASSWORD_CHANGE_REQUIRED');

    const badChange = post({ action: 'auth.changePassword', session_token: token, old_password: SEED, new_password: 'short' });
    assert.equal(badChange.error.code, 'VALIDATION_ERROR');

    const changed = post({ action: 'auth.changePassword', session_token: token, old_password: SEED, new_password: 'MyOwnPass99' });
    assert.equal(changed.ok, true);
    assert.equal(post({ action: 'student.getOverview', session_token: token }).ok, true);
    assert.equal(post({ action: 'auth.me', session_token: token }).data.must_change_password, false);

    const all = JSON.stringify([wrong, login, blocked, changed]);
    assert.ok(!all.includes('v1$') && !all.includes('password_hash'));
  });

  it('removed actions are unknown', () => {
    const { context, post } = makeServer();
    context.setupSheets();
    for (const action of ['auth.google', 'auth.testSignIn']) assert.equal(post({ action }).error.code, 'UNKNOWN_ACTION');
    assert.equal(typeof context.googleSignIn_, 'undefined');
    assert.equal(typeof context.testSignIn_, 'undefined');
  });

  it('createBootstrapAdmin refuses when an active admin exists', () => {
    const { context } = makeServer({ ...PROPS, BOOTSTRAP_ADMIN_USERNAME: 'root', BOOTSTRAP_ADMIN_PASSWORD: 'FirstLogin2026' });
    context.setupSheets();
    assert.throws(() => context.createBootstrapAdmin(), /ADMIN_EXISTS/);
  });

  it('migrateUsersToPasswordLogin upgrades a Google-era Users tab, drops google_sub, and is idempotent', () => {
    const { context, ss, usersTab, logs, post } = makeServer();
    context.setupSheets();
    const sheet = ss.getSheetByName('Users');
    sheet.cells.length = 0;
    sheet.getRange(1, 1, 3, 9).setValues([
      ['user_id', 'email', 'google_sub', 'role', 'linked_id', 'account_status', 'created_by', 'last_login_at', 'created_at'],
      ['USR-0001', 'boss@psu.edu.ph', '123', 'admin', '', 'active', '', '', ''],
      ['USR-0002', 'x@psu.edu.ph', '', 'student', 'STU-0001', 'active', '', '', ''],
    ]);
    context.migrateUsersToPasswordLogin();
    const users = usersTab();
    assert.ok(!sheet.cells[0].includes('google_sub'));
    assert.equal(users[0].username, 'boss');
    assert.ok(users.every((u) => u.password_hash === '')); // no shared password; an admin must reset them
    assert.match(logs.join('\n'), /2 user\(s\) have no password.*Reset password/);
    assert.equal(post({ action: 'auth.login', username: 'boss', password: '' }).error.code, 'INVALID_CREDENTIALS');

    const snapshot = JSON.stringify(sheet.cells.map((r) => r.filter((_, i) => sheet.cells[0][i] !== 'last_login_at')));
    logs.length = 0;
    context.migrateUsersToPasswordLogin();
    assert.match(logs.join('\n'), /Nothing to change/);
    assert.equal(JSON.stringify(sheet.cells.map((r) => r.filter((_, i) => sheet.cells[0][i] !== 'last_login_at'))), snapshot);
  });

  it('write actions take the script lock (and release it); read actions do not', () => {
    const { context, post, locks } = makeServer();
    context.setupSheets();
    locks.taken = 0; locks.released = 0;
    const token = post({ action: 'auth.login', username: 'admin.test', password: SEED }).data.session_token;
    assert.deepEqual([locks.taken, locks.released], [1, 1], 'auth.login is a write');
    post({ action: 'auth.me', session_token: token });
    post({ action: 'admin.listStudents', session_token: token });
    assert.deepEqual([locks.taken, locks.released], [1, 1], 'reads must not lock');
    post({ action: 'auth.changePassword', session_token: token, old_password: SEED, new_password: 'NewAdmin99' });
    assert.deepEqual([locks.taken, locks.released], [2, 2]);
  });

  it('a busy lock answers BUSY and saves nothing', () => {
    const { context, post, locks, usersTab } = makeServer();
    context.setupSheets();
    const before = JSON.stringify(usersTab());
    locks.available = false;
    const reply = post({ action: 'auth.login', username: 'admin.test', password: 'wrong-pass1' });
    assert.equal(reply.error.code, 'BUSY');
    assert.equal(JSON.stringify(usersTab()), before);
  });
});
