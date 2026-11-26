// device.submitScans (step 4d, Device_API_Spec 6.1 / 8.1). The device is already
// authenticated (runDeviceAction). Scans are handled oldest first and each one
// changes the db before the next, so a batch sees its own taps (DUPLICATE, one
// new session shared). Server.gs saves everything in one batchUpdate or nothing.
import { AppError, nextId, setting, toManilaIso, manilaAt, shiftDate } from '../utils.js';
import { resolveScan, roomSlots } from '../sessions.js';
import { joinedAfter } from './portal.js';
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
  // Same 1-32 rule as heartbeat; a bad value is ignored, never a reason to drop the scans.
  if (HEARTBEAT_FIELDS.firmware_version(request.firmware_version)) device.firmware_version = request.firmware_version.trim();
  return { results, roster_version: rosterVersion(db) };
}

const rosterVersion = (db) => Number(setting(db, 'roster_version', 0)) || 0;

const HEARTBEAT_FIELDS = {
  battery_voltage: (v) => typeof v === 'number' && v >= 0 && v <= 6,
  wifi_rssi: (v) => Number.isInteger(v) && v >= -127 && v <= 0,
  queue_count: (v) => Number.isInteger(v) && v >= 0,
  time_synced: (v) => typeof v === 'boolean',
  firmware_version: (v) => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 32,
  uptime_seconds: (v) => Number.isInteger(v) && v >= 0,
};

// device.heartbeat (Device_API_Spec 6.2), every ~5 minutes per device: updates
// only this device's row. No AuditLog row (it would flood the log).
export function heartbeat(db, request, device, ctx) {
  Object.entries(HEARTBEAT_FIELDS).forEach(([field, valid]) => {
    if (!valid(request[field])) throw new AppError('BAD_REQUEST', `${field} is missing or invalid.`);
  });
  const now = toManilaIso(ctx.now());
  const volts = Math.round(request.battery_voltage * 100) / 100; // stored value = compared value
  Object.assign(device, {
    battery_voltage: String(volts),
    wifi_rssi: String(request.wifi_rssi),
    queue_count: String(request.queue_count),
    time_synced: request.time_synced ? 'TRUE' : 'FALSE',
    firmware_version: request.firmware_version.trim(),
    last_heartbeat_at: now,
    last_seen_at: now,
  });
  const lowBattery = volts < Number(setting(db, 'low_battery_voltage', 3.5));
  return { roster_version: rosterVersion(db), low_battery: lowBattery };
}

const ROSTER_HOURS = 48;
const epochOf = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`) / 1000;

// device.getRoster (Device_API_Spec 6.3, v0.3): the offline cache. The device
// uses it only when it cannot reach the server; submitScans stays the authority.
// cards = ACTIVE cards of ACTIVE students (LCD names). windows = every tap window
// in the device's room overlapping [now, now+48h], from the session engine
// (roomSlots); uids = cards of students enrolled in that class (joinedAfter rule).
// roster_version = hash of settings + cards + windows, so any change shows.
export function getRoster(db, request, device, ctx) {
  const nowMs = ctx.now();
  const now = Math.floor(nowMs / 1000);
  const until = now + ROSTER_HOURS * 3600;
  const students = new Map(db.Students.filter((row) => row.account_status === 'active').map((row) => [row.student_id, row]));
  const activeCards = db.RfidCards.filter((card) => card.status === 'active' && students.has(card.student_id));
  const early = Number(setting(db, 'early_window_minutes', 15)) || 0;
  const afterEnd = Number(setting(db, 'accept_after_end_minutes', 0)) || 0;
  const labels = new Map(db.Classes.map((row) => [row.class_id, row.class_label]));

  const windows = [];
  for (let date = manilaAt(nowMs).date; date <= manilaAt(until * 1000).date; date = shiftDate(date, 1)) {
    const slots = roomSlots(db, device.room_id, date);
    if (!slots) continue;
    [...slots.manual, ...slots.scheduled].forEach((slot) => {
      const start = epochOf(date, slot.start) - early * 60;
      const end = epochOf(date, slot.end) + afterEnd * 60;
      if (end < now || start > until) return;
      const enrolled = new Set(db.Enrollments
        .filter((row) => row.class_id === slot.classId && row.status === 'enrolled' && !joinedAfter(db, slot.classId, row.student_id, date, slot.end))
        .map((row) => row.student_id));
      windows.push({
        start,
        end,
        label: String(labels.get(slot.classId) ?? slot.classId).slice(0, LCD_WIDTH),
        cancelled: slot.session?.status === 'cancelled',
        uids: activeCards.filter((card) => enrolled.has(card.student_id)).map((card) => card.rfid_uid),
      });
    });
  }
  windows.sort((a, b) => a.start - b.start || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  const content = {
    settings: {
      duplicate_window_minutes: Number(setting(db, 'duplicate_window_minutes', 5)),
      roster_refresh_seconds: Number(setting(db, 'heartbeat_interval_seconds', 300)),
    },
    cards: activeCards.map((card) => ({ uid: card.rfid_uid, name: shortName(students.get(card.student_id)) })),
    windows,
  };
  const version = ctx.tokenHash(JSON.stringify(content)).slice(0, 16); // plain SHA-256, used only as a change marker

  // Last-seen info (columns exist in Devices); a bad value is ignored, like submitScans.
  device.last_seen_at = toManilaIso(nowMs);
  if (HEARTBEAT_FIELDS.firmware_version(request.firmware_version)) device.firmware_version = request.firmware_version.trim();
  if (HEARTBEAT_FIELDS.queue_count(request.queue_count)) device.queue_count = String(request.queue_count);

  if (String(request.known_version ?? '') === version) return { changed: false, roster_version: version };
  return { changed: true, roster_version: version, generated_at: now, valid_until: until, ...content };
}
