// Runs the REAL Server.gs + Bundle.gs + SeedData.gs inside a Node vm with a
// small fake of the Apps Script services (in-memory spreadsheet). Checks the
// wiring that unit tests cannot: routing, saving failed logins, setupSheets,
// the editor-only jobs. Run `node tools/build_apps_script.mjs` first.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';

const dir = new URL('../apps-script/', import.meta.url);
const source = ['SeedData.gs', 'Bundle.gs', 'Server.gs'].map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');

const PROPS = {
  PASSWORD_PEPPER: 'vm-test-pepper', DEFAULT_STUDENT_PASSWORD: 'Student2026',
  DEFAULT_INSTRUCTOR_PASSWORD: 'Teach2026', DEFAULT_ADMIN_PASSWORD: 'Admin2026',
};

function fakeSheet(name) {
  const cells = [];
  const sheet = {
    cells,
    getName: () => name,
    getLastRow: () => { for (let r = cells.length; r > 0; r -= 1) if ((cells[r - 1] || []).some((v) => v !== '')) return r; return 0; },
    getLastColumn: () => cells.reduce((max, row) => { for (let c = row.length; c > max; c -= 1) if (row[c - 1] !== '') return c; return max; }, 0),
    getMaxRows: () => Math.max(cells.length, 1000),
    clear: () => { cells.length = 0; },
    setFrozenRows: () => {}, setTabColor: () => {},
    deleteColumn: (col) => cells.forEach((row) => row.splice(col - 1, 1)),
    getDataRange: () => sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), Math.max(sheet.getLastColumn(), 1)),
    getRange(row, col, numRows = 1, numCols = 1) {
      const range = {
        setNumberFormat: () => range, setFontWeight: () => range, setBackground: () => range, setNote: () => range, setFormula: () => range,
        setValues(values) {
          values.forEach((vals, i) => {
            const r = row - 1 + i;
            while (cells.length <= r) cells.push([]);
            vals.forEach((v, j) => { cells[r][col - 1 + j] = String(v); });
          });
          return range;
        },
        clearContent() {
          for (let i = 0; i < numRows; i += 1) for (let j = 0; j < numCols; j += 1) if (cells[row - 1 + i]) cells[row - 1 + i][col - 1 + j] = '';
          return range;
        },
        getDisplayValues: () => Array.from({ length: numRows }, (_, i) => Array.from({ length: numCols }, (_, j) => {
          const v = (cells[row - 1 + i] || [])[col - 1 + j];
          return v === undefined ? '' : v;
        })),
      };
      return range;
    },
  };
  return sheet;
}

function makeServer(props = PROPS) {
  const sheets = [fakeSheet('Sheet1')];
  const ss = {
    getId: () => 'fake', getSheets: () => sheets.slice(),
    getSheetByName: (n) => sheets.find((s) => s.getName() === n) || null,
    insertSheet: (n) => { const s = fakeSheet(n); sheets.push(s); return s; },
    deleteSheet: (s) => sheets.splice(sheets.indexOf(s), 1),
  };
  const toSigned = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
  const logs = [];
  const fmt = (date, pattern) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).map((x) => [x.type, x.value]));
    return pattern.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
  };
  const context = vm.createContext({
    console: { log: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (n) => props[n] ?? null, getProperties: () => ({ ...props }) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text) => ({ setMimeType: () => ({ text }) }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      computeDigest: (alg, bytes) => {
        bytes.forEach((b) => { if (b < -128 || b > 127) throw new Error('not a Java byte'); });
        return toSigned(createHash('sha256').update(Buffer.from(bytes.map((b) => b & 0xff))).digest());
      },
      newBlob: (text) => ({ getBytes: () => toSigned(Buffer.from(String(text), 'utf8')) }),
      getUuid: () => randomUUID(),
      formatDate: fmt,
    },
  });
  vm.runInContext(source, context);
  vm.runInContext('setupViews = function () {};', context); // formulas are not under test
  const post = (body) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  const usersTab = () => {
    const [head, ...rows] = ss.getSheetByName('Users').cells;
    return rows.filter((r) => r.some((v) => v !== '')).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
  };
  return { context, ss, post, logs, usersTab };
}

describe('Server.gs in a fake Apps Script', () => {
  it('setupSheets seeds users with default-password hashes, no google_sub', () => {
    const { context, usersTab, logs } = makeServer();
    context.setupSheets();
    const users = usersTab();
    assert.ok(users.length > 0);
    assert.ok(users.every((u) => u.password_hash.startsWith('v1$') && u.must_change_password === 'TRUE'));
    assert.ok(!('google_sub' in users[0]));
    assert.ok(!logs.join('\n').includes('Student2026'));
  });

  it('setupSheets refuses to seed users without the password properties', () => {
    const { context } = makeServer({ PASSWORD_PEPPER: 'x' });
    assert.throws(() => context.setupSheets(), /DEFAULT_STUDENT_PASSWORD/);
  });

  it('full login flow over doPost: login, gate, failed attempt saved, change password', () => {
    const { context, post, usersTab } = makeServer();
    context.setupSheets();
    const student = usersTab().find((u) => u.role === 'student');

    const wrong = post({ action: 'auth.login', username: student.username, password: 'Nope12345' });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error.code, 'INVALID_CREDENTIALS');
    assert.equal(usersTab().find((u) => u.user_id === student.user_id).failed_attempts, '1'); // saved despite the error

    const login = post({ action: 'auth.login', username: student.username, password: 'Student2026' });
    assert.equal(login.ok, true);
    assert.equal(login.data.must_change_password, true);
    const token = login.data.session_token;

    const blocked = post({ action: 'student.getOverview', session_token: token });
    assert.equal(blocked.error.code, 'PASSWORD_CHANGE_REQUIRED');

    const badChange = post({ action: 'auth.changePassword', session_token: token, old_password: 'Student2026', new_password: 'short' });
    assert.equal(badChange.error.code, 'VALIDATION_ERROR');

    const changed = post({ action: 'auth.changePassword', session_token: token, old_password: 'Student2026', new_password: 'MyOwnPass99' });
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
    assert.ok(users.every((u) => u.password_hash.startsWith('v1$')));
    assert.equal(post({ action: 'auth.login', username: 'boss', password: 'Admin2026' }).data.must_change_password, true);

    const snapshot = JSON.stringify(sheet.cells.map((r) => r.filter((_, i) => sheet.cells[0][i] !== 'last_login_at')));
    logs.length = 0;
    context.migrateUsersToPasswordLogin();
    assert.match(logs.join('\n'), /Nothing to change/);
    assert.equal(JSON.stringify(sheet.cells.map((r) => r.filter((_, i) => sheet.cells[0][i] !== 'last_login_at'))), snapshot);
  });
});
