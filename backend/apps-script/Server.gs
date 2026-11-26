/**
 * RFID Attendance — Apps Script Web App (the "server").
 *
 * The website sends every request here as a POST with a JSON body:
 *   { "action": "auth.login", "username": "...", "password": "..." }
 *   { "action": "instructor.getSession", "session_token": "...", ...fields }
 *   { "action": "device.*", "device_id": "...", "device_key": "...", ...fields }   (ESP32)
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
 *   TEST_SEED_PASSWORD           TEST Sheet only: password of the FAKE seeded users (setupSheets).
 *                                Also the test-Sheet marker (setupSheets, issueTestDeviceKey,
 *                                checkSetup): NEVER set it on the production Sheet.
 * Production Sheet: setupEmptySheets() (no fake data), see docs/PRODUCTION_SETUP.md.
 *   BOOTSTRAP_ADMIN_USERNAME     only for createBootstrapAdmin()
 *   BOOTSTRAP_ADMIN_PASSWORD     only for createBootstrapAdmin(); DELETE it afterwards
 *   SPREADSHEET_ID               only if this script is NOT created from inside the Sheet
 * New and reset accounts get a random temporary password, shown to the admin
 * once (DEFAULT_*_PASSWORD properties are no longer used).
 */

var LOCK_WAIT_MS = 10000; // answer SERVER_BUSY before the device's 20 s HTTP timeout
var VIEW_PREFIX = 'View - ';
var REQUIRED_PROPERTIES = ['PASSWORD_PEPPER'];
var OBSOLETE_PROPERTIES = ['GOOGLE_CLIENT_ID', 'ALLOW_TEST_LOGIN', 'DEFAULT_STUDENT_PASSWORD', 'DEFAULT_INSTRUCTOR_PASSWORD', 'DEFAULT_ADMIN_PASSWORD'];

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
  return reply_({ ok: true, server_time: serverTime_(), data: { service: 'RFID Attendance API', status: 'running' } });
}

function reply_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

// One clock for the whole request: ctx.now() (authContext_) and server_time.
function nowMs_() {
  return Date.now();
}

// Manila ISO with +08:00 (Device_API_Spec 5.1): the device checks its clock drift with it.
function serverTime_() {
  return RFID.toManilaIso(nowMs_());
}

function success_(data) {
  return { ok: true, server_time: serverTime_(), data: data };
}

function failure_(code, message, fields) {
  var error = { code: code, message: message };
  if (fields) error.fields = fields;
  return { ok: false, server_time: serverTime_(), error: error };
}

/* ===================== Router ===================== */
// Every action is in Bundle.gs. User actions (auth.*, admin.*, instructor.*,
// student.*): RFID.runAction checks the session, the role and the forced
// password change. ESP32 actions (device.*: device_id + device_key in the body):
// RFID.runDeviceAction checks the device key; no user session is used.
// Both: only the declared tabs are loaded; writes run under the script lock and
// are saved in ONE batchUpdate (all or nothing), so ok:true means saved.

function handleRequest_(request) {
  var action = String((request && request.action) || '');
  var isDevice = action.indexOf('device.') === 0;
  var spec;
  var isWrite;
  if (isDevice) {
    spec = RFID.deviceTabsFor(action);
    isWrite = spec.write.length > 0;
  } else {
    var entry = RFID.findAction(action);
    if (!entry) return failure_('UNKNOWN_ACTION', 'Unknown action: ' + action);
    spec = RFID.tabsFor(action);
    isWrite = entry.mode === RFID.WRITE;
  }

  var lock = null;
  var state = null;
  var t = [Date.now()];
  try {
    if (isWrite) {
      lock = LockService.getScriptLock();
      if (!lock.tryLock(LOCK_WAIT_MS)) return failure_('SERVER_BUSY', 'The server is busy. Please try again.');
    }
    t.push(Date.now());
    var ctx = authContext_();
    state = loadDb_(spec, action, isWrite);
    t.push(Date.now());
    var data = isDevice ? RFID.runDeviceAction(state.db, request, ctx) : RFID.runAction(state.db, request, ctx);
    t.push(Date.now());
    if (isWrite) saveDb_(state);
    t.push(Date.now());
    // Where a device request spends its time (Stage 2 A2). Web App logs are not
    // visible for anonymous requests, so it goes in the reply. No secrets in it.
    if (isDevice) {
      data.timing = { lock_ms: t[1] - t[0], load_ms: t[2] - t[1], run_ms: t[3] - t[2], save_ms: t[4] - t[3], total_ms: t[4] - t[0] };
    }
    return success_(data);
  } catch (error) {
    // Normally nothing is saved when an action fails. Exception: a failed
    // sign-in (error.commit) must save the failure counter, lock and audit row.
    if (error && error.commit === true && isWrite && state) {
      try { saveDb_(state); } catch (saveError) { console.error(saveError && saveError.stack ? saveError.stack : saveError); }
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
    now: nowMs_,
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
    var state = loadDb_(null, 'editor job', true);
    var lines = job(state.db, authContext_());
    saveDb_(state);
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
 * Lists ACTIVE classes (same term) that share a room, an instructor or a
 * section at the same day and time. Read-only: no lock, nothing is saved.
 * Fix each clash in the Admin portal (move or deactivate a schedule).
 */
function listScheduleClashes() {
  var spec = { read: ['Classes', 'Schedules', 'Rooms', 'Instructors', 'Sections'], write: [], append: [] };
  var lines = RFID.findScheduleClashes(loadDb_(spec, 'listScheduleClashes', false).db);
  console.log(lines.length ? lines.length + ' schedule clash(es):\n' + lines.join('\n') : 'No schedule clashes between active classes.');
  return lines;
}

/**
 * TEST SHEET ONLY. Gives a device a new key and LOGS it once, so the firmware
 * can be tested without the Admin portal. Refuses unless TEST_SEED_PASSWORD is
 * set (the test-Sheet marker; never set it on the production Sheet). The old
 * key stops working. Example: issueTestDeviceKey('DEV-RM301-01'); to run it
 * from the editor dropdown, write a one-line wrapper with your device id.
 */
function issueTestDeviceKey(deviceId) {
  runEditorJob_(function (db, ctx) {
    var result = RFID.issueTestDeviceKey(db, ctx, deviceId);
    return ['TEST device key for ' + result.device_id + ' (shown once, copy it now): ' + result.device_key];
  });
}

/**
 * TEST SHEET ONLY. Puts one user's password back to TEST_SEED_PASSWORD (they
 * must change it at next sign-in), clears the lockout and the temporary-password
 * expiry, and signs them out everywhere. Refuses unless TEST_SEED_PASSWORD is
 * set, and on an unknown username. Never logs the password.
 * Example: resetTestUserPassword('admin.test'); from the editor dropdown, write
 * a one-line wrapper with the username.
 */
function resetTestUserPassword(username) {
  runEditorJob_(function (db, ctx) {
    return RFID.resetTestUserPassword(db, ctx, username);
  });
}

/**
 * TEST SHEET ONLY (step 4f live test). Adds a temporary ACTIVE schedule
 * (now - 10 min .. now + 60 min, today, Manila) for the class with the most
 * enrolled students with active cards, in a room with an active device. Same
 * clash checks as the Admin portal. Logs the device, room, class and the UIDs
 * to paste as environment variables for tools/live_device_test.mjs.
 * Safe to run again (reuses the slot while it covers now). Undo: cleanupLiveTest.
 */
function prepareLiveTest() {
  runEditorJob_(function (db, ctx) {
    var r = RFID.prepareLiveTest(db, ctx);
    return [
      (r.reused ? 'Reusing' : 'Created') + ' LIVE TEST schedule ' + r.schedule_id + ': ' + r.class_label + ' (' + r.class_id + ') in '
        + r.room_code + ' (' + r.room_id + '), ' + r.day_of_week + ' ' + r.start_time + '-' + r.end_time,
      'Device: ' + r.device_id + ' (get a key with issueTestDeviceKey("' + r.device_id + '") if you have none)',
      'Environment variables for tools/live_device_test.mjs:',
      'DEVICE_ID=' + r.device_id,
      'LIVE_UIDS=' + r.enrolled_uids.join(','),
      'NOT_ENROLLED_UID=' + r.not_enrolled_uid,
      'UNKNOWN_UID=' + r.unknown_uid,
    ];
  });
}

/**
 * TEST SHEET ONLY. Sets every LIVE TEST schedule inactive. Attendance and
 * ScanLog rows from the test stay (they are test data). Safe to run again.
 */
function cleanupLiveTest() {
  runEditorJob_(function (db, ctx) { return RFID.cleanupLiveTest(db, ctx); });
}

/**
 * TEST SHEET ONLY. Deletes every data row except admin.test (Users), RM301
 * (Rooms) and DEV-RM301-01 (Devices, key hash kept), and bumps roster_version.
 * Keeps headers, Settings and the "View - …" tabs. DRY RUN unless the Script
 * Property CONFIRM_WIPE = YES; that property is deleted after every run.
 */
function wipeTestData() {
  var props = props_();
  var confirm = props.getProperty('CONFIRM_WIPE') === 'YES';
  try {
    return runEditorJob_(function (db, ctx) { return RFID.wipeTestData(db, ctx, confirm); });
  } finally {
    props.deleteProperty('CONFIRM_WIPE'); // one YES = one wipe
  }
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

// Loads the tabs a request needs (spec = RFID.tabsFor(action)); spec null = every
// tab (editor jobs). Returns the state saveDb_ needs:
//   state.db    what handlers get (guarded: see RFID.guardDb)
//   state.tabs  per tab: headers, lastRow (sheet row of the last record),
//               width, count (rows loaded), mode 'full' | 'append', snapshot
// Append tabs (spec.append) load only the header and the LAST row: enough for
// the next id, because ids only grow and new rows go at the end. Do not sort
// the raw tabs by hand (use the "View - …" tabs): "last row = highest id"
// would break. A blank or malformed last id falls back to a full read.
function loadDb_(spec, label, isWrite) {
  var ss = spreadsheet_();
  var state = { ss: ss, raw: {}, tabs: {}, isWrite: isWrite, writable: spec ? spec.write.slice() : null };
  var sheets = {};
  ss.getSheets().forEach(function (sheet) {
    if (!isViewTab_(sheet.getName())) sheets[sheet.getName()] = sheet; // "View - …" tabs are for people, not data
  });
  state.sheets = sheets;
  var full = spec ? spec.read : uniq_(Object.keys(sheets).concat(Object.keys(RFID.TAB_COLUMNS)));
  readTabs_(state, full, spec ? spec.append : []);
  state.db = spec ? RFID.guardDb(state.raw, spec, function (name) {
    // Lenient on the live site: slower, never broken. tabs.test.js fails instead.
    console.warn(label + ' read the undeclared tab ' + name + ': add it to its reads in backend/src/actions.js');
    if (isWrite) state.writable.push(name);
    readTabs_(state, [name], []);
    return state.raw[name];
  }) : state.raw;
  return state;
}

function uniq_(list) {
  return list.filter(function (item, i) { return list.indexOf(item) === i; });
}

function quoted_(name) {
  return "'" + name.replace(/'/g, "''") + "'";
}

// ONE values.batchGet for every range (much faster than one call per tab).
function batchGet_(ss, ranges) {
  if (!ranges.length) return [];
  if (typeof Sheets === 'undefined' || !Sheets.Spreadsheets) {
    throw new Error('Turn on the Sheets advanced service (appsscript.json: enabledAdvancedServices Sheets v4).');
  }
  var response = Sheets.Spreadsheets.Values.batchGet(ss.getId(), { ranges: ranges, valueRenderOption: 'FORMATTED_VALUE' });
  return (response.valueRanges || []).map(function (range) { return range.values || []; });
}

var ID_PATTERN = /^[A-Z]+-\d+$/;

function readTabs_(state, fullNames, appendNames) {
  var ranges = [];
  var plan = [];
  fullNames.forEach(function (name) {
    if (!state.sheets[name]) return setTab_(state, name, 'full', [], [], 0);
    ranges.push(quoted_(name));
    plan.push({ name: name, kind: 'full' });
  });
  appendNames.forEach(function (name) {
    var sheet = state.sheets[name];
    if (!sheet) return setTab_(state, name, 'append', [], [], 0);
    var last = sheet.getLastRow();
    ranges.push(quoted_(name) + '!1:1');
    plan.push({ name: name, kind: 'head', last: last });
    if (last > 1) {
      ranges.push(quoted_(name) + '!' + last + ':' + last);
      plan.push({ name: name, kind: 'tail', last: last });
    }
  });
  var results = batchGet_(state.ss, ranges);
  var heads = {};
  var refetch = [];
  plan.forEach(function (item, i) {
    var values = results[i] || [];
    if (item.kind === 'full') return setTab_(state, item.name, 'full', values[0] || [], values.slice(1), values.length);
    if (item.kind === 'head') {
      heads[item.name] = values[0] || [];
      if (item.last <= 1) setTab_(state, item.name, 'append', heads[item.name], [], item.last);
      return;
    }
    var row = values[0] || [];
    var id = String(row[0] === undefined ? '' : row[0]).trim();
    if (!ID_PATTERN.test(id)) {
      console.warn(item.name + ': last row id "' + id + '" is blank or malformed, full read to find the highest id');
      refetch.push(item.name);
      return;
    }
    setTab_(state, item.name, 'append', heads[item.name], [row], item.last);
  });
  if (refetch.length) {
    batchGet_(state.ss, refetch.map(quoted_)).forEach(function (values, i) {
      setTab_(state, refetch[i], 'append', values[0] || [], values.slice(1), values.length);
    });
  }
}

function setTab_(state, name, mode, headerRow, body, lastRow) {
  var cols = headerRow.map(function (h) { return String(h).trim(); });
  var records = [];
  var rowNumbers = []; // sheet row of each record (blank rows typed into the Sheet are skipped)
  body.forEach(function (row, i) {
    if (!row.some(function (cell) { return cell !== '' && cell !== undefined; })) return;
    var record = {};
    cols.forEach(function (col, j) { if (col) record[col] = row[j] === undefined ? '' : String(row[j]); });
    records.push(record);
    rowNumbers.push(i + 2);
  });
  var width = body.reduce(function (max, row) { return Math.max(max, row.length); }, cols.length);
  var tracked = state.isWrite && mode === 'full' && (state.writable === null || state.writable.indexOf(name) !== -1);
  state.raw[name] = records;
  state.tabs[name] = {
    // Keep blank header cells in place: saves write column by position, so dropping one would shift every later cell.
    // shortcut: a column with no header is written empty in rows the server saves; name the column if it must keep data.
    headers: cols.some(Boolean) ? cols : [], lastRow: lastRow, width: width, count: records.length, mode: mode, rowNumbers: rowNumbers,
    snapshot: tracked ? records.map(function (row) { return JSON.stringify(row); }) : null,
  };
}

// Saves every change of the request in ONE spreadsheets.batchUpdate. Google
// documents it as all-or-nothing ("if any request is not valid, no requests
// will be applied") and applied in order. Not covered by that: a call that
// times out after Google applied it (the user then sees an error although it
// was saved), and edits by people working in the Sheet at the same moment.
function saveDb_(state) {
  var changes = [];
  Object.keys(state.tabs).forEach(function (name) {
    var change = tabChange_(name, state.tabs[name], state.raw[name]);
    if (change) changes.push(change);
  });
  if (!changes.length) return;

  changes.forEach(function (change) {
    if (!state.sheets[change.name]) state.sheets[change.name] = state.ss.insertSheet(change.name); // empty new tab: harmless if the batch fails
  });
  var grid = {};
  Sheets.Spreadsheets.get(state.ss.getId(), { fields: 'sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))' })
    .sheets.forEach(function (sheet) { grid[sheet.properties.title] = sheet.properties; });

  var requests = [];
  changes.forEach(function (change) {
    var props = grid[change.name];
    var sheetId = props.sheetId;
    var rows = props.gridProperties.rowCount;
    var cols = props.gridProperties.columnCount;
    // Make room first, in the same batch (row/column limits of the grid).
    if (change.rowsNeeded > rows) requests.push({ appendDimension: { sheetId: sheetId, dimension: 'ROWS', length: change.rowsNeeded - rows } });
    if (change.width > cols) requests.push({ appendDimension: { sheetId: sheetId, dimension: 'COLUMNS', length: change.width - cols } });
    if (change.header) requests.push({ updateCells: { start: { sheetId: sheetId, rowIndex: 0, columnIndex: 0 }, rows: [cellRow_(change.headers, change.width)], fields: 'userEnteredValue' } });
    (change.edits || []).forEach(function (edit) {
      requests.push({ updateCells: { start: { sheetId: sheetId, rowIndex: edit.rowNumber - 1, columnIndex: 0 }, rows: [edit.row], fields: 'userEnteredValue' } });
    });
    if (change.append) requests.push({ appendCells: { sheetId: sheetId, rows: change.append, fields: 'userEnteredValue' } });
    if (change.rewrite) requests.push({ updateCells: { start: { sheetId: sheetId, rowIndex: 1, columnIndex: 0 }, rows: change.rewrite, fields: 'userEnteredValue' } });
  });
  Sheets.Spreadsheets.batchUpdate({ requests: requests }, state.ss.getId());
}

// What changed in one tab: null, or { header?, edits?, append? | rewrite?, rowsNeeded, width }.
// Rows edited in place are written one by one (their own sheet row), new rows
// at the end are appended; only when rows were removed is the body rewritten.
function tabChange_(name, tab, rows) {
  var added = [];
  var edited = [];
  var rewrite = false;
  if (tab.mode === 'append') {
    added = rows.slice(tab.count);
  } else if (tab.snapshot) {
    var old = tab.snapshot;
    if (rows.length < old.length) {
      rewrite = true;
    } else {
      rows.forEach(function (row, i) {
        if (i >= old.length) added.push(row);
        else if (JSON.stringify(row) !== old[i]) edited.push(i);
      });
    }
  } else {
    return null; // read-only for this request (guardDb froze it)
  }
  if (!rewrite && !added.length && !edited.length) return null;

  var headers = tab.headers.length ? tab.headers.slice() : defaultHeaders_(name);
  var header = tab.headers.length === 0 || tab.lastRow === 0;
  (rewrite ? rows : added.concat(edited.map(function (i) { return rows[i]; }))).forEach(function (row) {
    Object.keys(row).forEach(function (key) {
      if (headers.indexOf(key) === -1) { headers.push(key); header = true; }
    });
  });
  var width = Math.max(headers.length, tab.width);
  var change = { name: name, headers: headers, header: header, width: width };
  var toRows = function (list) { return list.map(function (row) { return cellRow_(headers.map(function (col) { return row[col]; }), width); }); };
  if (rewrite) {
    // Overwrite in place and blank the old tail: never "clear, then write".
    var body = toRows(rows);
    while (body.length < tab.lastRow - 1) body.push(cellRow_([], width));
    change.rewrite = body;
    change.rowsNeeded = 1 + body.length;
  } else {
    change.edits = edited.map(function (i) { return { rowNumber: tab.rowNumbers[i], row: toRows([rows[i]])[0] }; });
    if (added.length) change.append = toRows(added);
    change.rowsNeeded = Math.max(tab.lastRow, 1) + added.length;
  }
  return change;
}

// Plain text cells: stringValue is stored as typed ("07:30", "0024…").
function cellRow_(values, width) {
  var cells = [];
  for (var i = 0; i < width; i += 1) {
    var value = values[i];
    cells.push(value === undefined || value === null || value === '' ? {} : { userEnteredValue: { stringValue: String(value) } });
  }
  return { values: cells };
}

function defaultHeaders_(name) {
  return (RFID.TAB_COLUMNS[name] || []).slice();
}

/* ===================== One-time setup (run from the editor) ===================== */

/**
 * Creates every tab with its column names, formatted as plain text.
 * Tabs that are still EMPTY are filled with the FAKE test data, so the portals
 * have something to show. Tabs that already have records are never touched.
 * The seed data has NO passwords: the FAKE seeded users all get the
 * TEST_SEED_PASSWORD Script Property (hashed) and must change it at first
 * sign-in. TEST_SEED_PASSWORD is for fake test users only, never real people.
 * Safe to run more than once. TEST spreadsheet only.
 */
function setupSheets() {
  // Always: TEST_SEED_PASSWORD marks a TEST Sheet. Without it this could fill a
  // production Sheet with fake people (use setupEmptySheets there).
  var missing = REQUIRED_PROPERTIES.concat(['TEST_SEED_PASSWORD']).filter(function (name) { return !props_().getProperty(name); });
  if (missing.length) throw new Error('setupSheets is for a TEST Sheet only. Set these Script Properties first: ' + missing.join(', ') + '. For the production Sheet run setupEmptySheets instead.');
  var ss = spreadsheet_();
  var report = [];
  var usersSheet = ss.getSheetByName('Users');
  var seedsUsers = !usersSheet || usersSheet.getLastRow() <= 1;
  Object.keys(RFID.TAB_COLUMNS).forEach(function (name) {
    var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    var headers = defaultHeaders_(name);
    if (!headers.length) { report.push(name + ': no columns known, skipped'); return; }
    if (sheet.getLastRow() > 1) { report.push(name + ': already has data, left alone'); return; }
    sheet.clear();
    sheet.getRange(1, 1, sheet.getMaxRows(), headers.length).setNumberFormat('@');
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    var rows = (SEED_DATA[name] || []).map(function (row) {
      return headers.map(function (col) { return row[col] === undefined ? '' : String(row[col]); });
    });
    if (rows.length) sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    report.push(name + ': created with ' + rows.length + ' test row(s)');
  });
  var blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);
  console.log(report.join('\n'));
  if (seedsUsers) {
    runEditorJob_(function (db, ctx) { return RFID.seedTestPasswords(db, ctx); });
  }
  setupViews();
}

/**
 * PRODUCTION Sheet setup (docs/PRODUCTION_SETUP.md). Creates every missing tab
 * with its columns (plain text), adds missing columns at the end of existing
 * tabs, adds missing Settings rows with their defaults (roster_version = 1), and
 * builds the "View" tabs. NO fake data. Never changes existing cells, so it is
 * safe to run again. Refuses on a TEST Sheet (TEST_SEED_PASSWORD set).
 */
function setupEmptySheets() {
  if (props_().getProperty('TEST_SEED_PASSWORD')) {
    throw new Error('TEST_SEED_PASSWORD is set, so this is a TEST Sheet: use setupSheets there. Never set TEST_SEED_PASSWORD on the production Sheet.');
  }
  var ss = spreadsheet_();
  var report = [];
  Object.keys(RFID.TAB_COLUMNS).forEach(function (name) {
    var columns = RFID.TAB_COLUMNS[name];
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      report.push(name + ': created');
    }
    var have = sheet.getLastColumn() ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(function (h) { return String(h).trim(); }) : [];
    var missing = columns.filter(function (col) { return have.indexOf(col) === -1; });
    if (!missing.length) return;
    var start = have.length + 1;
    sheet.getRange(1, start, sheet.getMaxRows(), missing.length).setNumberFormat('@');
    sheet.getRange(1, start, 1, missing.length).setValues([missing]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    if (have.length) report.push(name + ': added column(s) ' + missing.join(', '));
  });

  var settings = ss.getSheetByName('Settings');
  var head = settings.getRange(1, 1, 1, settings.getLastColumn()).getDisplayValues()[0];
  var keyCol = head.indexOf('key');
  var keys = settings.getLastRow() > 1
    ? settings.getRange(2, keyCol + 1, settings.getLastRow() - 1, 1).getDisplayValues().map(function (r) { return String(r[0]).trim(); })
    : [];
  var rows = RFID.DEFAULT_SETTINGS
    .filter(function (row) { return keys.indexOf(row.key) === -1; })
    .map(function (row) { return head.map(function (col) { return row[col] === undefined ? '' : String(row[col]); }); });
  if (rows.length) {
    settings.getRange(settings.getLastRow() + 1, 1, rows.length, head.length).setValues(rows);
    report.push('Settings: added ' + rows.map(function (r) { return r[keyCol]; }).join(', '));
  }

  var blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);
  setupViews();
  console.log(report.length ? report.join('\n') : 'Nothing to change: every tab, column and Settings row is already there.');
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
  // Effective status (a correction wins). Older Sheets may not have the column yet.
  var effectiveStatus = att('status');
  try { var ov = att('override_status'); effectiveStatus = 'IF(' + ov + '<>"",' + ov + ',' + att('status') + ')'; } catch (e) { /* keep status */ }
  var attendanceColumns = [
    ['Date', lookup(att('session_id'), 'ClassSessions', 'session_date')],
    ['Time in', 'MID(' + att('scanned_at') + ',12,5)'],
    ['Student no.', lookup(att('student_id'), 'Students', 'student_number')],
    ['Student', studentName(att('student_id'))],
    ['Class', lookup(lookup(att('session_id'), 'ClassSessions', 'class_id'), 'Classes', 'class_label')],
    ['Room', lookup(lookup(att('session_id'), 'ClassSessions', 'room_id'), 'Rooms', 'room_code')],
    ['Status', 'PROPER(' + effectiveStatus + ')'],
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
    'Every attendance record with names; Status includes corrections. Enrolled students with no row count as absent once the class ends.');
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

/** Quick check from the editor: TEST or PRODUCTION, then each tab and how many records it has. */
function checkSetup() {
  var props = props_().getProperties();
  console.log(props.TEST_SEED_PASSWORD ? 'Environment: TEST (TEST_SEED_PASSWORD is set; never real people here)' : 'Environment: PRODUCTION');
  var db = loadDb_(null, 'checkSetup', false).db;
  console.log(Object.keys(db).map(function (name) { return name + ': ' + db[name].length; }).join('\n'));
  // Only says whether each property is set, never its value.
  REQUIRED_PROPERTIES.forEach(function (name) { console.log(name + ' set: ' + Boolean(props[name])); });
  if (props.BOOTSTRAP_ADMIN_PASSWORD) console.warn('BOOTSTRAP_ADMIN_PASSWORD is still set. Delete it once the first admin exists.');
  OBSOLETE_PROPERTIES.forEach(function (name) {
    if (props[name]) console.warn(name + ' is no longer used: safe to delete this Script Property.');
  });
  var noPassword = (db.Users || []).filter(function (u) { return !u.password_hash; }).length;
  if (noPassword) console.warn(noPassword + ' user(s) have no password and cannot sign in. An admin must use Reset password for each.');

  var settings = {};
  (db.Settings || []).forEach(function (row) { settings[row.key] = String(row.value == null ? '' : row.value).trim(); });
  // Version 0 or no row: devices never get a roster and card changes cannot bump it.
  if (!(Number(settings.roster_version) >= 1)) {
    console.warn('Settings: roster_version is missing or below 1. Devices will not download the roster. Add/set it to 1 in the Settings tab.');
  }
  var volts = settings.low_battery_voltage;
  if (volts === undefined || volts === '' || !isFinite(Number(volts))) {
    console.warn('Settings: low_battery_voltage is missing or not a number. Low-battery alerts are off. Set it (e.g. 3.5) in the Settings tab.');
  }
}
