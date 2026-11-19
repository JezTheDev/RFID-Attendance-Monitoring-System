// device.submitScans (step 4d, Device_API_Spec 6.1 / 8.1). The device is already
// authenticated (runDeviceAction). Scans are handled oldest first and each one
// changes the db before the next, so a batch sees its own taps (DUPLICATE, one
// new session shared). Server.gs saves everything in one batchUpdate or nothing.
import { AppError, nextId, setting, toManilaIso } from '../utils.js';
import { resolveScan } from '../sessions.js';
import { normalizeUid, UID_PATTERN } from './students.js';

const MAX_SCANS = 20;
const TIME_QUALITIES = ['ntp', 'backfilled', 'unverified'];
const SYNC_MODES = ['live', 'offline'];
const LCD_WIDTH = 16;
const SEQUENCE_PATTERN = /^\d{6}-\d{6}$/; // <boot_count>-<sequence> after "<device_id>-"

const isEpoch = (value) => Number.isInteger(value) && value >= 0;

// Any bad item is a firmware bug: BAD_REQUEST for the whole request.
function validScans(request, deviceId) {
  const { scans, sent_at: sentAt } = request;
  if (!isEpoch(sentAt)) throw new AppError('BAD_REQUEST', 'sent_at must be epoch seconds (0 if the clock is not synced).');
  if (!Array.isArray(scans) || scans.length < 1 || scans.length > MAX_SCANS) {
    throw new AppError('BAD_REQUEST', `scans must have 1 to ${MAX_SCANS} items.`);
  }
  return scans.map((item, i) => {
    const scan = item || {};
    const uid = typeof scan.rfid_uid === 'string' ? normalizeUid(scan.rfid_uid) : '';
    // A scan_id must carry THIS device's id, so one device cannot replay another's.
    const ownId = typeof scan.scan_id === 'string' && scan.scan_id.startsWith(`${deviceId}-`)
      && SEQUENCE_PATTERN.test(scan.scan_id.slice(deviceId.length + 1));
    let field = '';
    if (!ownId) field = 'scan_id';
    else if (!UID_PATTERN.test(uid)) field = 'rfid_uid';
    else if (!isEpoch(scan.scanned_at)) field = 'scanned_at';
    else if (!TIME_QUALITIES.includes(scan.time_quality)) field = 'time_quality';
    else if (!SYNC_MODES.includes(scan.sync_mode)) field = 'sync_mode';
    if (field) throw new AppError('BAD_REQUEST', `scans[${i}].${field} is missing or invalid.`);
    return { ...scan, rfid_uid: uid };
  });
}

// "J. Dela Cruz", at most 16 characters (LCD line 2).
function shortName(student) {
  if (!student) return '';
  const initial = student.first_name ? `${student.first_name[0]}. ` : '';
  return `${initial}${student.last_name}`.slice(0, LCD_WIDTH);
}

function answer(db, scanId, result, studentId) {
  const student = studentId ? db.Students.find((row) => row.student_id === studentId) : null;
  return {
    scan_id: scanId,
    result,
    attendance_status: result === 'ACCEPTED' ? 'PRESENT' : '',
    final: true,
    lcd_line2: result === 'ACCEPTED' || result === 'DUPLICATE' ? shortName(student) : '',
  };
}

function handleScan(db, scan, device, settings, nowMs, receivedAt) {
  const original = db.ScanLog.find((row) => row.scan_id === scan.scan_id);
  if (original) {
    const first = answer(db, scan.scan_id, original.result, original.student_id);
    return { ...first, result: 'ALREADY_RECORDED', original_result: original.result };
  }

  const card = db.RfidCards.find((row) => row.rfid_uid === scan.rfid_uid && row.status === 'active');
  const student = card ? db.Students.find((row) => row.student_id === card.student_id && row.account_status === 'active') : null;
  let decision;
  // The student is looked up even for INVALID_TIME, so the admin can review it.
  if (scan.time_quality === 'unverified' || scan.scanned_at === 0) decision = { result: 'INVALID_TIME' };
  else if (!student) decision = { result: 'UNREGISTERED' };
  else decision = resolveScan(db, { room_id: device.room_id, scanned_at: scan.scanned_at, student_id: student.student_id }, settings, nowMs);

  const scannedAt = scan.scanned_at ? toManilaIso(scan.scanned_at * 1000) : '';
  let attendanceId = '';
  if (decision.result === 'ACCEPTED') {
    if (decision.newSession) db.ClassSessions.push(decision.newSession);
    attendanceId = nextId(db.Attendance, 'attendance_id', 'ATT', 5);
    db.Attendance.push({
      attendance_id: attendanceId,
      session_id: (decision.newSession || decision.session).session_id,
      student_id: student.student_id,
      card_id: card.card_id,
      rfid_uid: scan.rfid_uid,
      device_id: device.device_id,
      scan_id: scan.scan_id,
      scanned_at: scannedAt,
      received_at: receivedAt,
      status: decision.attendance_status,
      source: 'device',
      sync_mode: scan.sync_mode,
      time_quality: scan.time_quality,
      created_by: '',
      override_status: '',
      override_by: '',
      override_at: '',
      override_reason: '',
    });
  }
  const session = decision.newSession || decision.session;
  db.ScanLog.push({
    log_id: nextId(db.ScanLog, 'log_id', 'LOG', 5),
    scan_id: scan.scan_id,
    device_id: device.device_id,
    rfid_uid: scan.rfid_uid,
    scanned_at: scannedAt,
    received_at: receivedAt,
    result: decision.result,
    session_id: session ? session.session_id : '',
    student_id: student ? student.student_id : '',
    attendance_id: attendanceId,
    sync_mode: scan.sync_mode,
  });
  return answer(db, scan.scan_id, decision.result, student && student.student_id);
}

export function submitScans(db, request, device, ctx) {
  const scans = validScans(request, device.device_id);
  const nowMs = ctx.now();
  const receivedAt = toManilaIso(nowMs);
  const settings = Object.fromEntries(db.Settings.map((row) => [row.key, row.value]));
  const results = scans.map((scan) => handleScan(db, scan, device, settings, nowMs, receivedAt));

  device.last_seen_at = receivedAt;
  if (typeof request.firmware_version === 'string' && request.firmware_version.trim()) {
    device.firmware_version = request.firmware_version.trim();
  }
  return { results, roster_version: Number(setting(db, 'roster_version', 0)) || 0 };
}
