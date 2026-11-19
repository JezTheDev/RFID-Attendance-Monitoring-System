// Runs the REAL Server.gs + Bundle.gs + SeedData.gs inside a Node vm with a
// small fake of the Apps Script services (helpers/fake-apps-script.js). Checks the
// wiring that unit tests cannot: routing, saving failed logins, setupSheets,
// the editor-only jobs, and how many tabs/rows each request reads and writes.
// Run `node tools/build_apps_script.mjs` first.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
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

  it('backfillOverrideReasons runs from the editor and is idempotent', () => {
    const { context, logs } = makeServer();
    context.setupSheets();
    logs.length = 0;
    context.backfillOverrideReasons();
    context.backfillOverrideReasons();
    assert.match(logs.at(-1), /Nothing to change/);
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

/* ---------------- Step 4a: read only what is needed, write only what changed ---------------- */

const allCells = (ss) => JSON.stringify(ss.getSheets().map((s) => [s.getName(), s.cells]));

// A seeded server with a signed-in admin whose password is already changed.
function ready() {
  const server = makeServer();
  server.context.setupSheets();
  const login = (username, password = SEED) => server.post({ action: 'auth.login', username, password }).data.session_token;
  const admin = login('admin.test');
  server.post({ action: 'auth.changePassword', session_token: admin, old_password: SEED, new_password: 'NewAdmin99' });
  server.resetStats();
  return { ...server, admin, login };
}

describe('Server.gs reads only the declared tabs', () => {
  it('auth.me reads exactly the session tabs + Instructors/Students (display name)', () => {
    const { post, stats, admin } = ready();
    assert.equal(post({ action: 'auth.me', session_token: admin }).ok, true);
    assert.deepEqual([...stats.tabsRead].sort(), ['AuthSessions', 'Instructors', 'Students', 'Users']);
  });

  it('an unknown action reads nothing', () => {
    const { post, stats } = ready();
    assert.equal(post({ action: 'nope.nothing' }).error.code, 'UNKNOWN_ACTION');
    assert.deepEqual(stats.tabsRead, []);
  });

  it('student.getHistory never reads AuditLog', () => {
    const { post, stats, usersTab, login } = ready();
    const student = usersTab().find((u) => u.role === 'student');
    const token = login(student.username);
    post({ action: 'auth.changePassword', session_token: token, old_password: SEED, new_password: 'MyOwnPass99' });
    stats.tabsRead.length = 0;
    assert.equal(post({ action: 'student.getHistory', session_token: token }).ok, true);
    assert.ok(stats.tabsRead.length > 0 && !stats.tabsRead.some((t) => t.startsWith('AuditLog')), stats.tabsRead.join());
  });

  it('a write reads AuditLog as header + last row only, and appends the next id', () => {
    const { post, stats, ss, tab } = ready();
    const last = ss.getSheetByName('AuditLog').getLastRow();
    assert.equal(post({ action: 'auth.login', username: 'admin.test', password: 'NewAdmin99' }).ok, true);
    const auditReads = stats.tabsRead.filter((t) => t.startsWith('AuditLog'));
    assert.deepEqual(auditReads, ['AuditLog rows 1-1', `AuditLog rows ${last}-${last}`]);
    const ids = tab('AuditLog').map((r) => r.audit_id);
    assert.equal(new Set(ids).size, ids.length, 'audit ids are unique');
    assert.equal(ids.at(-1), `AUD-${String(last).padStart(4, '0')}`);
  });

  for (const bad of ['', 'junk', 'AUD-']) {
    it(`a blank or malformed last AuditLog id (${JSON.stringify(bad)}) falls back to a full scan, no duplicate id`, () => {
      const { post, stats, ss, tab, logs } = ready();
      const sheet = ss.getSheetByName('AuditLog');
      sheet.cells[sheet.getLastRow() - 1][0] = bad;
      const highest = Math.max(...tab('AuditLog').map((r) => Number(r.audit_id.slice(4)) || 0));
      assert.equal(post({ action: 'auth.login', username: 'admin.test', password: 'NewAdmin99' }).ok, true);
      assert.ok(stats.tabsRead.includes('AuditLog'), 'full AuditLog read');
      const ids = tab('AuditLog').map((r) => r.audit_id).filter(Boolean);
      assert.equal(ids.at(-1), `AUD-${String(highest + 1).padStart(4, '0')}`);
      assert.equal(new Set(ids).size, ids.length, 'no duplicate id');
      assert.match(logs.join('\n'), /AuditLog: last row id .* full read/);
    });
  }

  it('an undeclared tab is still loaded on the live site (slower, not broken) and logs a warning', () => {
    const { post, context, admin, logs } = ready();
    vm.runInContext(`(function () {
      var original = RFID.tabsFor;
      RFID.tabsFor = function (name) {
        var spec = original(name);
        if (spec) spec.read = spec.read.filter(function (t) { return t !== 'Settings'; });
        return spec;
      };
    })();`, context);
    const reply = post({ action: 'admin.createAdmin', session_token: admin, username: 'admin3', display_name: 'Third', email: '' });
    assert.equal(reply.ok, true, JSON.stringify(reply.error));
    assert.match(logs.join('\n'), /admin\.createAdmin read the undeclared tab Settings/);
  });
});

describe('Server.gs saves in one all-or-nothing batchUpdate', () => {
  it('a READ action writes nothing; a write action makes exactly one batchUpdate', () => {
    const { post, stats, admin } = ready();
    post({ action: 'admin.listStudents', session_token: admin });
    assert.deepEqual([stats.batchUpdates, stats.rowsWritten], [0, 0]);
    post({ action: 'auth.login', username: 'admin.test', password: 'NewAdmin99' });
    assert.equal(stats.batchUpdates, 1);
  });

  it('login appends to AuditLog without touching its old rows', () => {
    const { post, ss } = ready();
    const sheet = ss.getSheetByName('AuditLog');
    const before = JSON.stringify(sheet.cells.slice(0, sheet.getLastRow()));
    post({ action: 'auth.login', username: 'admin.test', password: 'NewAdmin99' });
    assert.equal(JSON.stringify(sheet.cells.slice(0, JSON.parse(before).length)), before);
    assert.equal(sheet.getLastRow(), JSON.parse(before).length + 1);
  });

  it('an edited row is written alone: login writes 3 rows (1 Users, 1 AuthSessions, 1 AuditLog)', () => {
    const { post, ss, stats } = ready();
    const users = ss.getSheetByName('Users');
    const before = JSON.parse(JSON.stringify(users.cells));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100); // last_login_at has 1-second resolution
    post({ action: 'auth.login', username: 'admin.test', password: 'NewAdmin99' });
    assert.equal(stats.rowsWritten, 3);
    const changed = users.cells.map((row, i) => JSON.stringify(row) !== JSON.stringify(before[i])).filter(Boolean).length;
    assert.equal(changed, 1);
  });

  it('an edited row lands on its own sheet row even with blank rows in between', () => {
    const { post, ss, usersTab, admin } = ready();
    const users = ss.getSheetByName('Users');
    users.cells.splice(3, 0, users.cells[0].map(() => '')); // a blank row typed into the Sheet
    const target = usersTab().find((u) => u.role === 'student');
    const reply = post({ action: 'admin.resetPassword', session_token: admin, user_id: target.user_id });
    assert.equal(reply.ok, true, JSON.stringify(reply.error));
    assert.equal(usersTab().find((u) => u.user_id === target.user_id).must_change_password, 'TRUE');
    assert.equal(usersTab().length, new Set(usersTab().map((u) => u.user_id)).size, 'no duplicated user rows');
    assert.ok(users.cells[3].every((v) => v === ''), 'blank row left alone');
  });

  it('a tab that shrinks blanks its old tail (no stale rows left behind)', () => {
    const { post, ss, tab } = ready();
    const sheet = ss.getSheetByName('AuthSessions');
    const head = sheet.cells[0];
    const old = head.map((h) => (h === 'expires_at' ? '2020-01-01T00:00:00+08:00' : h === 'revoked' ? 'FALSE' : `old-${h}`));
    sheet.getRange(sheet.getLastRow() + 1, 1, 3, head.length).setValues([old, old, old]);
    const live = tab('AuthSessions').length - 3;
    post({ action: 'auth.login', username: 'admin.test', password: 'NewAdmin99' });
    const rows = tab('AuthSessions');
    assert.equal(rows.length, live + 1, 'expired sessions dropped, new one added');
    assert.ok(!rows.some((r) => r.token_hash === 'old-token_hash'));
  });

  it('appending past the grid makes room in the same batch (real Apps Script: UNVERIFIED, task 4f)', () => {
    const { post, ss, tab } = ready();
    const sheet = ss.getSheetByName('AuditLog');
    sheet.rowCount = sheet.getLastRow(); // grid exactly full
    const count = tab('AuditLog').length;
    assert.equal(post({ action: 'auth.login', username: 'admin.test', password: 'NewAdmin99' }).ok, true);
    assert.equal(tab('AuditLog').length, count + 1);
  });

  it('if the batchUpdate fails, nothing changes and the reply is SERVER_ERROR', () => {
    const { post, ss, stats, admin } = ready();
    const before = allCells(ss);
    stats.failNext = true;
    const reply = post({ action: 'admin.createStudent', session_token: admin, student_number: '2024999002', first_name: 'No', last_name: 'Save', section_id: 'SEC-0001' });
    assert.equal(reply.error.code, 'SERVER_ERROR');
    assert.equal(allCells(ss), before);
  });

  it('a failed sign-in still saves the counter and audit row in one batch', () => {
    const { post, stats, usersTab, tab } = ready();
    const audits = tab('AuditLog').length;
    assert.equal(post({ action: 'auth.login', username: 'admin.test', password: 'wrong-pass1' }).error.code, 'INVALID_CREDENTIALS');
    assert.equal(stats.batchUpdates, 1);
    assert.equal(usersTab().find((u) => u.username === 'admin.test').failed_attempts, '1');
    assert.equal(tab('AuditLog').length, audits + 1);
  });

  it('cells stay plain text (leading zeros kept)', () => {
    const { post, ss, admin } = ready();
    const reply = post({ action: 'admin.createStudent', session_token: admin, student_number: '0024999003', first_name: 'Zero', last_name: 'Lead', section_id: 'SEC-0001' });
    assert.equal(reply.ok, true, JSON.stringify(reply.error));
    assert.ok(ss.getSheetByName('Students').cells.some((r) => r.includes('0024999003')));
  });
});

describe('listScheduleClashes (editor only)', () => {
  it('logs clashes, reads only the schedule tabs, takes no lock and writes nothing', () => {
    const { context, ss, logs, stats, resetStats, locks, tab } = makeServer();
    context.setupSheets();
    const schedules = tab('Schedules');
    const sheet = ss.getSheetByName('Schedules');
    const head = sheet.cells[0];
    const first = schedules.find((s) => s.status === 'active');
    const other = schedules.find((s) => s.status === 'active' && s.class_id !== first.class_id);
    const row = sheet.cells.findIndex((r) => r[0] === other.schedule_id);
    ['day_of_week', 'start_time', 'end_time', 'room_id'].forEach((col) => { sheet.cells[row][head.indexOf(col)] = first[col]; });
    resetStats();
    logs.length = 0;
    const lockCount = locks.taken;
    context.listScheduleClashes();
    assert.match(logs.join('\n'), new RegExp(`${first.schedule_id}.*${other.schedule_id}|${other.schedule_id}.*${first.schedule_id}`));
    assert.match(logs.join('\n'), /share room/);
    assert.deepEqual([...stats.tabsRead].sort(), ['Classes', 'Instructors', 'Rooms', 'Schedules', 'Sections']);
    assert.deepEqual([stats.batchUpdates, stats.rowsWritten, locks.taken], [0, 0, lockCount]);
  });

  it('says so when there are no clashes', () => {
    const { context, ss, logs } = makeServer();
    context.setupSheets();
    const sheet = ss.getSheetByName('Schedules');
    sheet.cells.length = 1; // header only
    logs.length = 0;
    context.listScheduleClashes();
    assert.match(logs.join('\n'), /No schedule clashes/);
  });
});
