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

  // Settings tab edited by hand: [key, value] or [key, null] to delete the row.
  function checkSetupWith(changes) {
    const { context, ss, logs } = makeServer();
    context.setupSheets();
    const sheet = ss.getSheetByName('Settings');
    const keyCol = sheet.cells[0].indexOf('key');
    const valueCol = sheet.cells[0].indexOf('value');
    changes.forEach(([key, value]) => {
      const i = sheet.cells.findIndex((row) => row[keyCol] === key);
      if (value === null) sheet.cells.splice(i, 1);
      else sheet.cells[i][valueCol] = value;
    });
    logs.length = 0;
    context.checkSetup();
    return logs.join('\n');
  }

  it('checkSetup: seeded Settings give no roster_version / low_battery_voltage warning', () => {
    const text = checkSetupWith([]);
    assert.doesNotMatch(text, /roster_version|low_battery_voltage/);
  });

  it('checkSetup warns when roster_version is missing or below 1', () => {
    assert.match(checkSetupWith([['roster_version', null]]), /roster_version is missing or below 1/);
    assert.match(checkSetupWith([['roster_version', '0']]), /roster_version is missing or below 1/);
    assert.match(checkSetupWith([['roster_version', '']]), /roster_version is missing or below 1/);
    assert.match(checkSetupWith([['roster_version', 'abc']]), /roster_version is missing or below 1/);
  });

  it('checkSetup warns when low_battery_voltage is missing, empty or not a number', () => {
    assert.match(checkSetupWith([['low_battery_voltage', null]]), /low_battery_voltage is missing or not a number/);
    assert.match(checkSetupWith([['low_battery_voltage', '']]), /low_battery_voltage is missing or not a number/);
    assert.match(checkSetupWith([['low_battery_voltage', '  ']]), /low_battery_voltage is missing or not a number/);
    assert.match(checkSetupWith([['low_battery_voltage', '3.5V']]), /low_battery_voltage is missing or not a number/);
    assert.doesNotMatch(checkSetupWith([['low_battery_voltage', '3.3']]), /low_battery_voltage/);
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

  it('a busy lock answers SERVER_BUSY (spec 6.4) and saves nothing', () => {
    const { context, post, locks, usersTab } = makeServer();
    context.setupSheets();
    const before = JSON.stringify(usersTab());
    locks.available = false;
    const reply = post({ action: 'auth.login', username: 'admin.test', password: 'wrong-pass1' });
    assert.equal(reply.error.code, 'SERVER_BUSY');
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

/* ---------------- Step 4b: devices ---------------- */

describe('Server.gs device route and device keys', () => {
  // A new active device with a key in ROM-0001, made over doPost by the admin.
  // The seeded DEV-RM301-01 (active there) goes to maintenance first.
  function withDevice() {
    const server = ready();
    const { post, admin } = server;
    const call = (body) => {
      const reply = post({ session_token: admin, ...body });
      assert.equal(reply.ok, true, JSON.stringify(reply.error));
      return reply.data;
    };
    call({ action: 'admin.setDeviceStatus', device_id: 'DEV-RM301-01', status: 'maintenance' });
    const { device_id: deviceId } = call({ action: 'admin.createDevice', device_name: 'Test Reader', room_id: 'ROM-0001' });
    const { device_key: key } = call({ action: 'admin.generateDeviceKey', device_id: deviceId });
    call({ action: 'admin.setDeviceStatus', device_id: deviceId, status: 'active' });
    server.resetStats();
    return { ...server, deviceId, key };
  }

  it('device.* with the right key: authenticated, then UNKNOWN_ACTION; reads only Devices, writes nothing, no session', () => {
    const { post, stats, tab, deviceId, key } = withDevice();
    const sessionsBefore = tab('AuthSessions').length;
    const reply = post({ action: 'device.nope', device_id: deviceId, device_key: key });
    assert.equal(reply.error.code, 'UNKNOWN_ACTION');
    assert.deepEqual(stats.tabsRead, ['Devices']);
    assert.equal(stats.rowsWritten, 0);
    assert.equal(tab('AuthSessions').length, sessionsBefore);
  });

  it('device.* with a wrong key or unknown device: the same INVALID_DEVICE_KEY', () => {
    const { post, deviceId, key } = withDevice();
    const wrong = post({ action: 'device.nope', device_id: deviceId, device_key: 'f'.repeat(64) });
    const unknown = post({ action: 'device.nope', device_id: 'DEV-NOPE-99', device_key: key });
    assert.equal(wrong.error.code, 'INVALID_DEVICE_KEY');
    assert.deepEqual(unknown.error, wrong.error);
    assert.equal(post({ action: 'device.nope' }).error.code, 'BAD_REQUEST');
  });

  it('a generated device key is in the response only: no Sheet cell, no log; only its hash is stored', () => {
    const { ss, logs, tab, deviceId, key } = withDevice();
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.ok(!allCells(ss).includes(key), 'device key in a Sheet cell');
    assert.ok(!logs.join('\n').includes(key), 'device key in a log');
    const hash = tab('Devices').find((d) => d.device_id === deviceId).device_key_hash;
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(tab('AuditLog')).includes(hash), 'hash in AuditLog');
  });

  // Seed: CLS-0001 in ROM-0001 MON 07:30-09:00; STU-0001 has card 04B50101.
  // Monday 2026-11-23 has no ClassSession yet.
  const MON = '2026-11-23T07:40:00+08:00';
  const submit = (s, scans) => s.post({
    action: 'device.submitScans', device_id: s.deviceId, device_key: s.key,
    sent_at: Math.floor(Date.parse(MON) / 1000), firmware_version: '0.3.0', scans,
  });
  const scanOf = (s, n, uid = '04B50101', iso = '2026-11-23T07:35:00+08:00') => ({
    scan_id: `${s.deviceId}-000001-${String(n).padStart(6, '0')}`, rfid_uid: uid, scanned_at: Date.parse(iso) / 1000, time_quality: 'ntp', sync_mode: 'live',
  });
  function tapReady() {
    const s = withDevice();
    s.clock.ms = Date.parse(MON);
    return s;
  }

  it('device.submitScans: ACCEPTED, under the lock, declared tabs only, ONE batchUpdate of 4 rows', () => {
    const s = tapReady();
    const taken = s.locks.taken;
    const reply = submit(s, [scanOf(s, 1)]);
    assert.equal(reply.ok, true, JSON.stringify(reply.error));
    assert.deepEqual(reply.data.results.map((r) => [r.result, r.lcd_line2]), [['ACCEPTED', 'J. Dela Cruz']]);
    assert.equal(s.locks.taken, taken + 1);
    assert.deepEqual([...s.stats.tabsRead].sort(), [...s.context.RFID.deviceTabsFor('device.submitScans').read].sort());
    assert.deepEqual([s.stats.batchUpdates, s.stats.rowsWritten], [1, 4]); // ClassSessions, Attendance, ScanLog, Devices
    const att = s.tab('Attendance').at(-1);
    assert.deepEqual([att.student_id, att.scan_id, att.status, att.scanned_at], ['STU-0001', scanOf(s, 1).scan_id, 'present', '2026-11-23T07:35:00+08:00']);
    assert.equal(s.tab('Devices').find((d) => d.device_id === s.deviceId).last_seen_at, MON);
  });

  it('device.heartbeat: under the lock, declared tabs only, ONE row written, no AuditLog row', () => {
    const s = tapReady();
    const taken = s.locks.taken;
    const audit = s.tab('AuditLog').length;
    const reply = s.post({
      action: 'device.heartbeat', device_id: s.deviceId, device_key: s.key, sent_at: Math.floor(Date.parse(MON) / 1000),
      battery_voltage: 3.82, wifi_rssi: -61, queue_count: 0, time_synced: true, firmware_version: '0.3.0', uptime_seconds: 5400,
    });
    assert.equal(reply.ok, true, JSON.stringify(reply.error));
    assert.equal(reply.data.low_battery, false);
    assert.equal(s.locks.taken, taken + 1);
    assert.deepEqual([...s.stats.tabsRead].sort(), [...s.context.RFID.deviceTabsFor('device.heartbeat').read].sort());
    assert.deepEqual([s.stats.batchUpdates, s.stats.rowsWritten], [1, 1]);
    assert.equal(s.tab('AuditLog').length, audit);
    const row = s.tab('Devices').find((d) => d.device_id === s.deviceId);
    assert.deepEqual([row.battery_voltage, row.last_heartbeat_at, row.last_seen_at], ['3.82', MON, MON]);
  });

  it('device.getRoster: no lock, declared tabs only, nothing written', () => {
    const s = tapReady();
    const taken = s.locks.taken;
    const reply = s.post({ action: 'device.getRoster', device_id: s.deviceId, device_key: s.key, known_version: 0 });
    assert.equal(reply.ok, true, JSON.stringify(reply.error));
    assert.equal(reply.data.changed, true);
    assert.ok(reply.data.cards.some((c) => c.uid === '04B50101' && c.name === 'J. Dela Cruz'));
    assert.equal(s.locks.taken, taken);
    assert.deepEqual([...s.stats.tabsRead].sort(), [...s.context.RFID.deviceTabsFor('device.getRoster').read].sort());
    assert.deepEqual([s.stats.batchUpdates, s.stats.rowsWritten], [0, 0]);
    const again = s.post({ action: 'device.getRoster', device_id: s.deviceId, device_key: s.key, known_version: reply.data.roster_version });
    assert.deepEqual(again.data, { changed: false, roster_version: reply.data.roster_version });
  });

  it('device.submitScans resent: ALREADY_RECORDED and no new rows in the Sheet', () => {
    const s = tapReady();
    submit(s, [scanOf(s, 1)]);
    const lengths = () => ['ClassSessions', 'Attendance', 'ScanLog'].map((n) => s.tab(n).length);
    const before = lengths();
    const reply = submit(s, [scanOf(s, 1)]);
    assert.deepEqual([reply.data.results[0].result, reply.data.results[0].original_result], ['ALREADY_RECORDED', 'ACCEPTED']);
    assert.deepEqual(lengths(), before);
  });

  it('device.submitScans with a wrong key: INVALID_DEVICE_KEY and nothing written', () => {
    const s = tapReady();
    const before = allCells(s.ss);
    const reply = s.post({ action: 'device.submitScans', device_id: s.deviceId, device_key: 'f'.repeat(64), sent_at: 0, scans: [scanOf(s, 1)] });
    assert.equal(reply.error.code, 'INVALID_DEVICE_KEY');
    assert.equal(s.stats.batchUpdates, 0);
    assert.equal(allCells(s.ss), before);
  });

  it('device.submitScans when the write fails: SERVER_ERROR and nothing half-saved', () => {
    const s = tapReady();
    const before = allCells(s.ss);
    s.stats.failNext = true;
    const reply = submit(s, [scanOf(s, 1), scanOf(s, 2, '04B50201')]);
    assert.deepEqual([reply.ok, reply.error.code], [false, 'SERVER_ERROR']);
    assert.equal(allCells(s.ss), before);
  });

  it('device.submitScans when the lock is busy: SERVER_BUSY and nothing saved', () => {
    const s = tapReady();
    const before = allCells(s.ss);
    s.locks.available = false;
    assert.equal(submit(s, [scanOf(s, 1)]).error.code, 'SERVER_BUSY');
    assert.equal(allCells(s.ss), before);
  });

  it('device.submitScans with a bad item: BAD_REQUEST and nothing saved', () => {
    const s = tapReady();
    const before = allCells(s.ss);
    assert.equal(submit(s, [scanOf(s, 1, 'XYZ')]).error.code, 'BAD_REQUEST');
    assert.equal(allCells(s.ss), before);
  });

  it('issueTestDeviceKey refuses without TEST_SEED_PASSWORD (production Sheet)', () => {
    const { context } = makeServer({ PASSWORD_PEPPER: 'vm-test-pepper' });
    assert.throws(() => context.issueTestDeviceKey('DEV-RM301-01'), /NOT_TEST_SHEET/);
  });

  it('issueTestDeviceKey on the TEST Sheet logs the key once and stores only its hash', () => {
    const { context, logs, tab } = makeServer();
    context.setupSheets();
    logs.length = 0;
    context.issueTestDeviceKey('DEV-RM301-01');
    const key = (logs.join('\n').match(/[0-9a-f]{64}/) || [])[0];
    assert.ok(key, 'key logged');
    assert.equal(logs.join('\n').split(key).length - 1, 1, 'logged exactly once');
    const device = tab('Devices').find((d) => d.device_id === 'DEV-RM301-01');
    assert.match(device.device_key_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(device.device_key_hash, key);
  });
});

describe('server_time (spec 5.1): Manila ISO with +08:00 from the same clock', () => {
  it('success, failure, bad JSON, doGet and device replies', () => {
    const { context, post, clock } = ready();
    clock.ms = Date.UTC(2026, 10, 20, 0, 5, 13);
    const want = '2026-11-20T08:05:13+08:00';
    const replies = [
      post({ action: 'auth.login', username: 'admin.test', password: 'NewAdmin99' }),
      post({ action: 'nope.nothing' }),
      JSON.parse(context.doPost({ postData: { contents: '{not json' } }).text),
      JSON.parse(context.doGet().text),
      post({ action: 'device.submitScans', device_id: 'DEV-NOPE-01', device_key: 'x' }),
    ];
    assert.equal(replies[0].ok, true);
    replies.forEach((reply) => assert.equal(reply.server_time, want));
  });
});

describe('prepareLiveTest / cleanupLiveTest editor jobs (step 4f)', () => {
  it('log the env lines, add one LIVE TEST schedule, then set it inactive', () => {
    const { context, tab, logs, clock } = makeServer();
    context.setupSheets();
    clock.ms = Date.parse('2026-11-23T11:00:00+08:00');
    const before = tab('Schedules').length;
    context.prepareLiveTest();
    const text = logs.join('\n');
    assert.match(text, /DEVICE_ID=DEV-/);
    assert.match(text, /LIVE_UIDS=\w+/);
    assert.match(text, /NOT_ENROLLED_UID=\w+/);
    assert.match(text, /UNKNOWN_UID=FFFFFF\d\d/);
    const added = tab('Schedules').slice(before);
    assert.equal(added.length, 1);
    assert.deepEqual([added[0].day_of_week, added[0].start_time, added[0].end_time, added[0].status], ['MON', '10:50', '12:00', 'active']);
    context.cleanupLiveTest();
    assert.equal(tab('Schedules').length, before + 1);
    assert.equal(tab('Schedules').at(-1).status, 'inactive');
  });
});
