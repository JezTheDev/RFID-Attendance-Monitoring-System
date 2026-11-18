/**
 * RFID Attendance — Apps Script Web App (the "server").
 *
 * The website sends every request here as a POST with a JSON body:
 *   { "action": "auth.login", "username": "...", "password": "..." }
 *   { "action": "instructor.getSession", "session_token": "...", ...fields }
 * and always gets back:
 *   { "ok": true,  "server_time": "...", "data": {...} }
 *   { "ok": false, "server_time": "...", "error": { "code", "message", "fields"? } }
 *
 * Files in this project:
 *   Server.gs    - this file: routing, reading/writing the Sheet, editor-only jobs (edit here)
 *   Bundle.gs    - all actions incl. login/sessions, GENERATED from backend/src (do not edit)
 *   SeedData.gs  - FAKE test data for setupSheets() on a TEST Sheet, GENERATED (do not edit)
 *
 * Script properties (Project Settings > Script properties). Never commit their values.
 *   PASSWORD_PEPPER              long random secret mixed into every password hash.
 *                                Changing it later makes EVERY password invalid.
 *   DEFAULT_STUDENT_PASSWORD     first password of new/reset student accounts
 *   DEFAULT_INSTRUCTOR_PASSWORD  first password of new/reset instructor accounts
 *   DEFAULT_ADMIN_PASSWORD       first password of new/reset admin accounts
 *   BOOTSTRAP_ADMIN_USERNAME     only for createBootstrapAdmin()
 *   BOOTSTRAP_ADMIN_PASSWORD     only for createBootstrapAdmin(); DELETE it afterwards
 *   SPREADSHEET_ID               only if this script is NOT created from inside the Sheet
 */

var AUTH_SESSION_HEADERS = ['token_hash', 'user_id', 'created_at', 'expires_at', 'revoked'];
var LOCK_WAIT_MS = 20000;
var VIEW_PREFIX = 'View - ';
var REQUIRED_PROPERTIES = ['PASSWORD_PEPPER', 'DEFAULT_STUDENT_PASSWORD', 'DEFAULT_INSTRUCTOR_PASSWORD', 'DEFAULT_ADMIN_PASSWORD'];

function isViewTab_(name) {
  return name.indexOf(VIEW_PREFIX) === 0;
}

/* ===================== Entry points ===================== */

function doPost(e) {
  var request;
  try {
    request = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (error) {
    return reply_(failure_('BAD_REQUEST', 'The request is not valid JSON.'));
  }
  return reply_(handleRequest_(request));
}

// Opening the Web App URL in a browser shows this, so you can check the deployment.
function doGet() {
  return reply_({ ok: true, server_time: new Date().toISOString(), data: { service: 'RFID Attendance API', status: 'running' } });
}

function reply_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

function success_(data) {
  return { ok: true, server_time: new Date().toISOString(), data: data };
}

function failure_(code, message, fields) {
  var error = { code: code, message: message };
  if (fields) error.fields = fields;
  return { ok: false, server_time: new Date().toISOString(), error: error };
}

/* ===================== Router ===================== */
// Every action (auth.*, admin.*, instructor.*, student.*) is in Bundle.gs:
// RFID.runAction checks the session, the role and the forced password change.

function handleRequest_(request) {
  var action = String((request && request.action) || '');
  var entry = RFID.findAction(action);
  if (!entry) return failure_('UNKNOWN_ACTION', 'Unknown action: ' + action);

  var isWrite = entry.mode === RFID.WRITE;
  var lock = null;
  var db = null;
  var before = null;
  try {
    if (isWrite) {
      lock = LockService.getScriptLock();
      if (!lock.tryLock(LOCK_WAIT_MS)) return failure_('BUSY', 'The server is busy. Please try again.');
    }
    var ctx = authContext_();
    db = loadDb_();
    before = isWrite ? snapshot_(db) : null;
    var data = RFID.runAction(db, request, ctx);
    if (isWrite) saveDb_(db, before);
    return success_(data);
  } catch (error) {
    // Normally nothing is saved when an action fails. Exception: a failed
    // sign-in (error.commit) must save the failure counter, lock and audit row.
    if (error && error.commit === true && isWrite && db) {
      try { saveDb_(db, before); } catch (saveError) { console.error(saveError && saveError.stack ? saveError.stack : saveError); }
    }
    if (error && typeof error.code === 'string') return failure_(error.code, error.message, error.fields || null);
    console.error(error && error.stack ? error.stack : error);
    return failure_('SERVER_ERROR', 'Unexpected server error. Please try again.');
  } finally {
    if (lock) lock.releaseLock();
  }
}

/* ===================== Auth wiring ===================== */

function props_() {
  return PropertiesService.getScriptProperties();
}

// Hashing (Utilities), Script Properties (read once per request) and the clock
// for the shared auth code in Bundle.gs.
function authContext_() {
  var all = props_().getProperties();
  return RFID.createAuthContext({
    crypto: RFID.appsScriptCrypto(),
    getProperty: function (name) { return all[name] || null; },
    now: function () { return Date.now(); },
  });
}

/* ===================== Editor-only account jobs ===================== */
// Run these from the Apps Script editor (function dropdown > Run). They are
// not Web App actions, so nobody can call them from the website.

// Loads the Sheet, runs job(db, ctx) -> lines to log, and saves only if it worked.
function runEditorJob_(job) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) throw new Error('The server is busy. Try again in a minute.');
  try {
    var db = loadDb_();
    var before = snapshot_(db);
    var lines = job(db, authContext_());
    saveDb_(db, before);
    console.log(lines.join('\n'));
    return lines;
  } catch (error) {
    if (error && typeof error.code === 'string') {
      throw new Error(error.code + ': ' + error.message + (error.fields ? ' ' + JSON.stringify(error.fields) : '') + ' (nothing was saved)');
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Creates the FIRST admin account from the Script Properties
 * BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD.
 * Refuses if an active admin already exists. The new admin must change the
 * password at first sign-in. DELETE BOOTSTRAP_ADMIN_PASSWORD afterwards.
 */
function createBootstrapAdmin() {
  runEditorJob_(function (db, ctx) {
    var result = RFID.createBootstrapAdmin(db, ctx);
    return [
      'Created admin "' + result.username + '" (' + result.user_id + '). They must change the password at first sign-in.',
      'NOW DELETE the BOOTSTRAP_ADMIN_PASSWORD Script Property (Project Settings > Script properties).',
    ];
  });
}

/**
 * Moves an existing (Google Sign-In era) Sheet to username + password login.
 * MAKE A COPY OF THE SPREADSHEET FIRST (File > Make a copy).
 * - adds the missing Users columns, removes google_sub
 * - usernames: students = student number; instructors/admins = email local part
 * - users without a password get their role's default password + must change
 * - Settings: removes allowed_email_rule, adds max_login_attempts / lockout_minutes
 * Safe to run again: the second run reports "nothing to change".
 */
function migrateUsersToPasswordLogin() {
  runEditorJob_(function (db, ctx) {
    var changes = RFID.migrateUsersToPasswordLogin(db, ctx);
    return changes.length ? changes : ['Nothing to change: the Users tab is already migrated.'];
  });
  dropEmptyColumn_('Users', 'google_sub');
}

// Deletes a column by header name, but only if every value below the header is empty.
function dropEmptyColumn_(tab, header) {
  var sheet = spreadsheet_().getSheetByName(tab);
  if (!sheet || sheet.getLastColumn() === 0) return;
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  var index = headers.indexOf(header);
  if (index === -1) return;
  if (sheet.getLastRow() > 1) {
    var values = sheet.getRange(2, index + 1, sheet.getLastRow() - 1, 1).getDisplayValues();
    if (values.some(function (row) { return row[0] !== ''; })) {
      console.log(tab + '.' + header + ' still has values, column kept.');
      return;
    }
  }
  sheet.deleteColumn(index + 1);
  console.log(tab + ': removed the empty "' + header + '" column.');
}

/**
 * Times password hashing here in Apps Script, to choose PASSWORD_HASH_ITERATIONS
 * (backend/src/auth/passwords.js). Aim for about 200-500 ms per hash.
 */
function benchmarkPasswordHash() {
  var crypto = RFID.appsScriptCrypto();
  var sample = 300;
  var start = Date.now();
  RFID.hashPassword(crypto, 'benchmark-only-pepper', 'Benchmark123', sample);
  var perIteration = (Date.now() - start) / sample;
  start = Date.now();
  RFID.hashPassword(crypto, 'benchmark-only-pepper', 'Benchmark123');
  var current = Date.now() - start;
  console.log('One SHA-256 iteration: ' + perIteration.toFixed(3) + ' ms');
  console.log('Current PASSWORD_HASH_ITERATIONS = ' + RFID.PASSWORD_HASH_ITERATIONS + ' -> one hash took ' + current + ' ms');
  console.log('For ~300 ms per hash use about ' + Math.max(1, Math.round(300 / Math.max(perIteration, 0.001))) + ' iterations.');
}

/* ===================== Reading and writing the Sheet ===================== */
// Each tab is a table: row 1 = column names, every other row = one record.
// All cells are kept as plain text, so "07:30" and "2026-10-26" stay as typed.

function spreadsheet_() {
  var id = props_().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function loadDb_() {
  var db = {};
  var headers = {};
  var ss = spreadsheet_();
  var names = ss.getSheets()
    .map(function (sheet) { return sheet.getName(); })
    .filter(function (name) { return !isViewTab_(name); }); // "View - …" tabs are for people, not data
  var tables = readAllTabs_(ss, names);
  names.forEach(function (name, index) {
    var values = tables[index] || [];
    var cols = (values[0] || []).map(function (h) { return String(h).trim(); });
    headers[name] = cols.filter(Boolean);
    db[name] = values.slice(1)
      .filter(function (row) { return row.some(function (cell) { return cell !== '' && cell !== undefined; }); })
      .map(function (row) {
        var record = {};
        cols.forEach(function (col, i) { if (col) record[col] = row[i] === undefined ? '' : String(row[i]); });
        return record;
      });
  });
  // Every table the code expects exists, even if its tab is missing or empty.
  Object.keys(SEED_DATA).forEach(function (name) { if (!db[name]) db[name] = []; });
  Object.defineProperty(db, '__headers', { value: headers, enumerable: false });
  return db;
}

// Reads every tab in ONE request with the Sheets API (much faster than one
// request per tab). The "Sheets" service is switched on in appsscript.json;
// if it is missing, fall back to reading the tabs one by one.
function readAllTabs_(ss, names) {
  if (typeof Sheets !== 'undefined' && Sheets.Spreadsheets && Sheets.Spreadsheets.Values) {
    var ranges = names.map(function (name) { return "'" + name.replace(/'/g, "''") + "'"; });
    var response = Sheets.Spreadsheets.Values.batchGet(ss.getId(), { ranges: ranges, valueRenderOption: 'FORMATTED_VALUE' });
    return (response.valueRanges || []).map(function (range) { return range.values || []; });
  }
  return names.map(function (name) { return ss.getSheetByName(name).getDataRange().getDisplayValues(); });
}

function snapshot_(db) {
  var copy = {};
  Object.keys(db).forEach(function (name) {
    copy[name] = db[name].map(function (row) { return JSON.stringify(row); });
  });
  return copy;
}

function saveDb_(db, before) {
  var ss = spreadsheet_();
  Object.keys(db).forEach(function (name) {
    var rows = db[name];
    var old = before[name] || [];
    var now = rows.map(function (row) { return JSON.stringify(row); });
    if (now.length === old.length && now.every(function (row, i) { return row === old[i]; })) return; // unchanged

    var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    var headers = (db.__headers[name] || []).slice();
    if (!headers.length) headers = defaultHeaders_(name);
    var headersGrew = false;
    rows.forEach(function (row) {
      Object.keys(row).forEach(function (key) {
        if (headers.indexOf(key) === -1) { headers.push(key); headersGrew = true; }
      });
    });
    if (headersGrew || sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, headers.length).setNumberFormat('@').setValues([headers]).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }

    var toValues = function (list) {
      return list.map(function (row) {
        return headers.map(function (col) { return row[col] === undefined || row[col] === null ? '' : String(row[col]); });
      });
    };

    // Common case (a new scan, a new student): rows were only added at the end.
    var appendedOnly = now.length > old.length && old.every(function (row, i) { return row === now[i]; });
    if (appendedOnly) {
      var added = toValues(rows.slice(old.length));
      var start = Math.max(sheet.getLastRow(), 1) + 1;
      sheet.getRange(start, 1, added.length, headers.length).setNumberFormat('@').setValues(added);
      return;
    }

    // Otherwise rewrite the table body.
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, Math.max(sheet.getLastColumn(), headers.length)).clearContent();
    if (rows.length) sheet.getRange(2, 1, rows.length, headers.length).setNumberFormat('@').setValues(toValues(rows));
  });
}

function defaultHeaders_(name) {
  if (name === 'AuthSessions') return AUTH_SESSION_HEADERS.slice();
  var sample = (SEED_DATA[name] || [])[0];
  return sample ? Object.keys(sample) : [];
}

/* ===================== One-time setup (run from the editor) ===================== */

/**
 * Creates every tab with its column names, formatted as plain text.
 * Tabs that are still EMPTY are filled with the FAKE test data, so the portals
 * have something to show. Tabs that already have records are never touched.
 * The seed data has NO passwords: seeded users get their role's default
 * password (from Script Properties) and must change it at first sign-in.
 * Safe to run more than once. TEST spreadsheet only.
 */
function setupSheets() {
  var ss = spreadsheet_();
  var report = [];
  var usersSheet = ss.getSheetByName('Users');
  var seedsUsers = !usersSheet || usersSheet.getLastRow() <= 1;
  if (seedsUsers) {
    var missing = REQUIRED_PROPERTIES.filter(function (name) { return !props_().getProperty(name); });
    if (missing.length) throw new Error('Set these Script Properties first (seeded users need default passwords): ' + missing.join(', '));
  }
  Object.keys(SEED_DATA).forEach(function (name) {
    var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    var headers = defaultHeaders_(name);
    if (!headers.length) { report.push(name + ': no columns known, skipped'); return; }
    if (sheet.getLastRow() > 1) { report.push(name + ': already has data, left alone'); return; }
    sheet.clear();
    sheet.getRange(1, 1, sheet.getMaxRows(), headers.length).setNumberFormat('@');
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    var rows = SEED_DATA[name].map(function (row) {
      return headers.map(function (col) { return row[col] === undefined ? '' : String(row[col]); });
    });
    if (rows.length) sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    report.push(name + ': created with ' + rows.length + ' test row(s)');
  });
  var blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);
  console.log(report.join('\n'));
  if (seedsUsers) {
    // Fill the password hashes of the seeded test users (same code as the migration).
    runEditorJob_(function (db, ctx) { return RFID.migrateUsersToPasswordLogin(db, ctx); });
  }
  setupViews();
}

/**
 * Creates read-only "View - …" tabs that show the records with real names,
 * dates, classes and rooms instead of IDs. They are live formulas, so they
 * update by themselves whenever a scan or correction is saved. The system
 * never reads or writes these tabs. Safe to run again (it rebuilds them).
 */
function setupViews() {
  var ss = spreadsheet_();

  var headerIndex = function (tab, header) {
    var sheet = ss.getSheetByName(tab);
    if (!sheet) throw new Error('Missing tab "' + tab + '". Run setupSheets first.');
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
    var index = headers.indexOf(header);
    if (index === -1) throw new Error('Column "' + header + '" was not found in the ' + tab + ' tab.');
    return index + 1;
  };
  var letter = function (n) {
    var s = '';
    while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };
  var column = function (tab, header) { var c = letter(headerIndex(tab, header)); return tab + '!' + c + '2:' + c; };
  var table = function (tab) { return tab + '!A2:' + letter(ss.getSheetByName(tab).getLastColumn()); };
  // Finds keys (IDs) in the first column of a tab and returns another column of that row.
  var lookup = function (keys, tab, header) {
    return 'IFERROR(VLOOKUP(' + keys + ',' + table(tab) + ',' + headerIndex(tab, header) + ',FALSE),"")';
  };
  var studentName = function (keys) {
    return lookup(keys, 'Students', 'last_name') + '&", "&' + lookup(keys, 'Students', 'first_name');
  };

  var att = function (h) { return column('Attendance', h); };
  var attendanceColumns = [
    ['Date', lookup(att('session_id'), 'ClassSessions', 'session_date')],
    ['Time in', 'MID(' + att('scanned_at') + ',12,5)'],
    ['Student no.', lookup(att('student_id'), 'Students', 'student_number')],
    ['Student', studentName(att('student_id'))],
    ['Class', lookup(lookup(att('session_id'), 'ClassSessions', 'class_id'), 'Classes', 'class_label')],
    ['Room', lookup(lookup(att('session_id'), 'ClassSessions', 'room_id'), 'Rooms', 'room_code')],
    ['Status', 'PROPER(' + att('status') + ')'],
    ['Recorded by', 'IF(' + att('source') + '="device","RFID tap","Instructor correction")'],
  ];

  var scan = function (h) { return column('ScanLog', h); };
  var scanColumns = [
    ['Date', 'LEFT(' + scan('scanned_at') + ',10)'],
    ['Time', 'MID(' + scan('scanned_at') + ',12,8)'],
    ['Card UID', scan('rfid_uid')],
    ['Student', 'IF(' + scan('student_id') + '="","(unknown card)",' + studentName(scan('student_id')) + ')'],
    ['Room', lookup(lookup(scan('device_id'), 'Devices', 'room_id'), 'Rooms', 'room_code')],
    ['Class', lookup(lookup(scan('session_id'), 'ClassSessions', 'class_id'), 'Classes', 'class_label')],
    ['Result', scan('result')],
  ];

  buildView_(ss, VIEW_PREFIX + 'Scans', scanColumns, scan('scanned_at'),
    'Every card tap, including rejected ones (unknown card, not enrolled, no class at that time).');
  buildView_(ss, VIEW_PREFIX + 'Attendance', attendanceColumns, att('student_id'),
    'Every Present/Late record with names. Absent students have no row (absent = enrolled but no record).');
  console.log('Views ready: "' + VIEW_PREFIX + 'Attendance" and "' + VIEW_PREFIX + 'Scans" (newest first).');
}

function buildView_(ss, name, columns, rowsExistColumn, note) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name, 0);
  sheet.clear();
  var headers = columns.map(function (c) { return c[0]; });
  var formula = '=ARRAYFORMULA(IFERROR(SORT(FILTER({' + columns.map(function (c) { return c[1]; }).join(',') + '},' +
    rowsExistColumn + '<>""),1,FALSE,2,FALSE),"No records yet"))';
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#f6e6e6');
  sheet.getRange(1, 1).setNote('READ-ONLY VIEW. ' + note + ' Edit the original tabs, never this one.');
  sheet.getRange(2, 1).setFormula(formula);
  sheet.setFrozenRows(1);
  sheet.setTabColor('#7a1f1f');
}

/** Quick check from the editor: lists each tab and how many records it has. */
function checkSetup() {
  var db = loadDb_();
  console.log(Object.keys(db).map(function (name) { return name + ': ' + db[name].length; }).join('\n'));
  var props = props_().getProperties();
  // Only says whether each property is set, never its value.
  REQUIRED_PROPERTIES.forEach(function (name) { console.log(name + ' set: ' + Boolean(props[name])); });
  if (props.BOOTSTRAP_ADMIN_PASSWORD) console.warn('BOOTSTRAP_ADMIN_PASSWORD is still set. Delete it once the first admin exists.');
  ['GOOGLE_CLIENT_ID', 'ALLOW_TEST_LOGIN'].forEach(function (name) {
    if (props[name]) console.warn(name + ' is no longer used. Delete this Script Property.');
  });
  var noPassword = (db.Users || []).filter(function (u) { return !u.password_hash; }).length;
  if (noPassword) console.warn(noPassword + ' user(s) have no password yet. Run migrateUsersToPasswordLogin.');
}
