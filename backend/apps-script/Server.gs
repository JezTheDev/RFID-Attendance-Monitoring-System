/**
 * RFID Attendance — Apps Script Web App (the "server").
 *
 * The website sends every request here as a POST with a JSON body:
 *   { "action": "instructor.getSession", "session_token": "...", ...fields }
 * and always gets back:
 *   { "ok": true,  "server_time": "...", "data": {...} }
 *   { "ok": false, "server_time": "...", "error": { "code", "message", "fields"? } }
 *
 * Files in this project:
 *   Server.gs    - this file: routing, sign-in, reading/writing the Sheet (edit here)
 *   Bundle.gs    - portal actions, GENERATED from frontend/assets/js (do not edit)
 *   SeedData.gs  - FAKE test data for setupSheets(), GENERATED (do not edit)
 *
 * Script properties (Project Settings > Script properties):
 *   GOOGLE_CLIENT_ID   OAuth Web client ID used by "Sign in with Google"
 *   ALLOW_TEST_LOGIN   "true" to allow the "Test as Admin/Instructor/Student"
 *                      buttons. Development only — turn it OFF before real use.
 *   SPREADSHEET_ID     only if this script is NOT created from inside the Sheet
 */

var AUTH_SESSION_HEADERS = ['token_hash', 'user_id', 'created_at', 'expires_at', 'revoked'];
var LOCK_WAIT_MS = 20000;
var VIEW_PREFIX = 'View - ';

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

var PUBLIC_ACTIONS = {
  'auth.google': { run: googleSignIn_, write: true },
  'auth.testSignIn': { run: testSignIn_, write: true },
  'auth.logout': { run: logout_, write: true },
};

function handleRequest_(request) {
  var action = String(request.action || '');
  var publicAction = PUBLIC_ACTIONS[action];
  var portalAction = RFID.ACTIONS[action];
  if (!publicAction && !portalAction) return failure_('UNKNOWN_ACTION', 'Unknown action: ' + action);

  var isWrite = publicAction ? publicAction.write : portalAction.mode === RFID.WRITE;
  var lock = null;
  try {
    if (isWrite) {
      lock = LockService.getScriptLock();
      if (!lock.tryLock(LOCK_WAIT_MS)) return failure_('BUSY', 'The server is busy. Please try again.');
    }
    var db = loadDb_();
    var before = isWrite ? snapshot_(db) : null;
    var data;
    if (publicAction) {
      data = publicAction.run(db, request);
    } else {
      var session = authorize_(db, request.session_token, portalAction.role);
      data = portalAction.run(db, request, session);
    }
    if (isWrite) saveDb_(db, before);
    return success_(data);
  } catch (error) {
    // Nothing is saved when an action fails, so the Sheet stays unchanged.
    if (error && typeof error.code === 'string') return failure_(error.code, error.message, error.fields || null);
    console.error(error && error.stack ? error.stack : error);
    return failure_('SERVER_ERROR', 'Unexpected server error. Please try again.');
  } finally {
    if (lock) lock.releaseLock();
  }
}

function apiError_(code, message) {
  var error = new Error(message);
  error.code = code;
  return error;
}

/* ===================== Sign-in and sessions ===================== */

function props_() {
  return PropertiesService.getScriptProperties();
}

function googleSignIn_(db, request) {
  var clientId = props_().getProperty('GOOGLE_CLIENT_ID');
  if (!clientId) throw apiError_('NOT_CONFIGURED', 'Google Sign-In is not set up on the server yet.');
  if (!request.id_token) throw apiError_('BAD_REQUEST', 'Missing Google sign-in token.');

  // Ask Google to check the token (signature, expiry) and give us its claims.
  var response = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(request.id_token),
    { muteHttpExceptions: true }
  );
  if (response.getResponseCode() !== 200) throw apiError_('INVALID_TOKEN', 'Google sign-in failed. Please try again.');
  var claims = JSON.parse(response.getContentText());
  var issuerOk = claims.iss === 'accounts.google.com' || claims.iss === 'https://accounts.google.com';
  if (claims.aud !== clientId || !issuerOk || Number(claims.exp) * 1000 < Date.now()) {
    throw apiError_('INVALID_TOKEN', 'Google sign-in failed. Please try again.');
  }
  if (String(claims.email_verified) !== 'true') throw apiError_('EMAIL_NOT_VERIFIED', 'Your Google email is not verified.');

  var email = String(claims.email || '').toLowerCase();
  var user = db.Users.filter(function (row) { return String(row.email).toLowerCase() === email; })[0];
  if (!user) throw apiError_('NOT_REGISTERED', 'This Google account (' + email + ') is not registered. Ask the administrator to add you.');
  if (user.account_status !== 'active') throw apiError_('ACCOUNT_DISABLED', 'Your account is disabled. Contact the administrator.');

  // Bind the Google account on first sign-in; afterwards it must match.
  if (!user.google_sub) {
    user.google_sub = String(claims.sub);
  } else if (user.google_sub !== String(claims.sub)) {
    throw apiError_('ACCOUNT_MISMATCH', 'This email is linked to a different Google account. Ask the administrator to reset it.');
  }
  return startSession_(db, user);
}

// Development helper: sign in as the first active user with a role.
// Works only while the script property ALLOW_TEST_LOGIN is "true".
function testSignIn_(db, request) {
  if (props_().getProperty('ALLOW_TEST_LOGIN') !== 'true') {
    throw apiError_('TEST_LOGIN_DISABLED', 'Test sign-in is turned off on the server.');
  }
  var role = String(request.role || '');
  var user = db.Users.filter(function (row) { return row.role === role && row.account_status === 'active'; })[0];
  if (!user) throw apiError_('NOT_REGISTERED', 'No active ' + role + ' account in the Users tab.');
  return startSession_(db, user);
}

function startSession_(db, user) {
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var hours = Number(RFID.setting(db, 'session_token_hours', 8));
  var now = new Date();
  var expires = new Date(now.getTime() + hours * 3600000);

  // Drop sessions that ended more than a day ago so the tab stays small.
  var cutoff = now.getTime() - 86400000;
  db.AuthSessions = db.AuthSessions.filter(function (row) { return Date.parse(row.expires_at) > cutoff; });
  db.AuthSessions.push({
    token_hash: hash_(token),
    user_id: user.user_id,
    created_at: RFID.manilaNow().iso,
    expires_at: expires.toISOString(),
    revoked: 'FALSE',
  });
  user.last_login_at = RFID.manilaNow().iso;

  return {
    session_token: token,
    user_id: user.user_id,
    role: user.role,
    display_name: displayName_(db, user),
    email: user.email,
    expires_at: expires.toISOString(),
  };
}

function logout_(db, request) {
  if (!request.session_token) return {};
  var tokenHash = hash_(request.session_token);
  db.AuthSessions.forEach(function (row) {
    if (row.token_hash === tokenHash) row.revoked = 'TRUE';
  });
  return {};
}

function authorize_(db, token, role) {
  var signedOut = apiError_('NOT_SIGNED_IN', 'Your session has ended. Please sign in again.');
  if (!token) throw signedOut;
  var tokenHash = hash_(token);
  var row = db.AuthSessions.filter(function (s) { return s.token_hash === tokenHash; })[0];
  if (!row || row.revoked === 'TRUE' || Date.parse(row.expires_at) <= Date.now()) throw signedOut;
  var user = db.Users.filter(function (u) { return u.user_id === row.user_id; })[0];
  if (!user || user.account_status !== 'active') throw signedOut;
  if (user.role !== role) throw apiError_('FORBIDDEN', 'You do not have access to this information.');
  return { user_id: user.user_id, role: user.role, email: user.email };
}

function displayName_(db, user) {
  var person = null;
  if (user.role === 'instructor') person = db.Instructors.filter(function (r) { return r.instructor_id === user.linked_id; })[0];
  if (user.role === 'student') person = db.Students.filter(function (r) { return r.student_id === user.linked_id; })[0];
  if (person) return person.first_name + ' ' + person.last_name;
  if (user.role === 'admin') return user.display_name || 'Administrator';
  return user.email;
}

function hash_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
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
 * Safe to run more than once.
 */
function setupSheets() {
  var ss = spreadsheet_();
  var report = [];
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
  console.log('GOOGLE_CLIENT_ID set: ' + Boolean(props_().getProperty('GOOGLE_CLIENT_ID')));
  console.log('ALLOW_TEST_LOGIN: ' + (props_().getProperty('ALLOW_TEST_LOGIN') || 'false'));
}
