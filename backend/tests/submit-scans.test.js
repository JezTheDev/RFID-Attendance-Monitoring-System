// Step 4d: device.submitScans (Device_API_Spec 6.1, 8.1). Fake clock everywhere.
//
// Fixture (helpers/db.js + below): device DEV-CPE-101-01 active in RM-0001.
// CLS-0001 (Ana): RM-0001 MON 08:00-10:00, STU-0001..0003. CLS-0002: RM-0002 TUE,
// plus SCH-0003 here: RM-0001 MON 13:00-15:00, STU-0004.
// Monday 2026-11-23 has no ClassSession yet. Cards: STU-0001 A1B2C3D4 (makeDb),
// STU-0002 04000002, STU-0003 04000003, STU-0004 04000004.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, SESSIONS, withCode } from './helpers/db.js';
import { makeCtx } from './helpers/auth.js';
import { createDevice, generateDeviceKey, setDeviceStatus } from '../src/handlers/devices.js';
import { listUnregisteredUids } from '../src/handlers/students.js';
import { runAction, runDeviceAction, deviceTabsFor, guardDb } from '../src/actions.js';
import { startSession } from '../src/auth/session.js';

const MON_0810 = '2026-11-23T08:10:00+08:00';
const epoch = (iso) => Date.parse(iso) / 1000;

function setup(nowIso = MON_0810) {
  const db = makeDb();
  const ctx = makeCtx({ startMs: Date.parse(nowIso) });
  db.Schedules.push({ schedule_id: 'SCH-0003', class_id: 'CLS-0002', room_id: 'RM-0001', day_of_week: 'MON', start_time: '13:00', end_time: '15:00', status: 'active' });
  ['2', '3', '4'].forEach((n) => db.RfidCards.push({
    card_id: `CRD-000${n}`, rfid_uid: `0400000${n}`, student_id: `STU-000${n}`, status: 'active', assigned_at: '', revoked_at: '', notes: '',
  }));
  const deviceId = createDevice(db, { device_name: 'Lab 1 Reader', room_id: 'RM-0001' }, SESSIONS.admin, ctx).device_id;
  const key = generateDeviceKey(db, { device_id: deviceId }, SESSIONS.admin, ctx).device_key;
  setDeviceStatus(db, { device_id: deviceId, status: 'active' }, SESSIONS.admin, ctx);
  let seq = 0;
  const scan = (uid, iso, extra = {}) => {
    seq += 1;
    return { scan_id: `${deviceId}-000001-${String(seq).padStart(6, '0')}`, rfid_uid: uid, scanned_at: epoch(iso), time_quality: 'ntp', sync_mode: 'live', ...extra };
  };
  const request = (scans, extra = {}) => ({
    action: 'device.submitScans', device_id: deviceId, device_key: key, sent_at: Math.floor(ctx.now() / 1000), firmware_version: '0.3.0', scans, ...extra,
  });
  const submit = (scans, extra) => runDeviceAction(db, request(scans, extra), ctx);
  const counts = () => [db.ClassSessions.length, db.Attendance.length, db.ScanLog.length];
  return { db, ctx, deviceId, key, scan, request, submit, counts };
}

const results = (data) => data.results.map((r) => r.result);

describe('device.submitScans: accepted tap', () => {
  it('creates the session, an Attendance row and a ScanLog row; answers ACCEPTED with a short name', () => {
    const { db, submit, scan, deviceId, counts } = setup();
    const before = counts();
    const s = scan('a1b2c3d4', '2026-11-23T08:05:30+08:00');
    const data = submit([s]);

    assert.deepEqual(data, {
      results: [{ scan_id: s.scan_id, result: 'ACCEPTED', attendance_status: 'PRESENT', final: true, lcd_line2: 'C. Santos' }],
      roster_version: 1,
    });
    assert.deepEqual(counts(), [before[0] + 1, before[1] + 1, before[2] + 1]);
    const session = db.ClassSessions.at(-1);
    assert.deepEqual([session.session_id, session.class_id, session.session_date, session.source, session.status], ['SES-0003', 'CLS-0001', '2026-11-23', 'auto', 'open']);
    const att = db.Attendance.at(-1);
    assert.deepEqual(
      [att.attendance_id, att.session_id, att.student_id, att.status, att.source, att.card_id, att.rfid_uid, att.device_id, att.scan_id, att.scanned_at, att.received_at, att.sync_mode, att.time_quality],
      ['ATT-00004', 'SES-0003', 'STU-0001', 'present', 'device', 'CRD-0001', 'A1B2C3D4', deviceId, s.scan_id, '2026-11-23T08:05:30+08:00', '2026-11-23T08:10:00+08:00', 'live', 'ntp'],
    );
    const log = db.ScanLog.at(-1);
    assert.deepEqual(
      [log.log_id, log.scan_id, log.device_id, log.rfid_uid, log.result, log.session_id, log.student_id, log.attendance_id, log.scanned_at, log.received_at, log.sync_mode],
      ['LOG-00001', s.scan_id, deviceId, 'A1B2C3D4', 'ACCEPTED', 'SES-0003', 'STU-0001', 'ATT-00004', '2026-11-23T08:05:30+08:00', '2026-11-23T08:10:00+08:00', 'live'],
    );
  });

  it('updates the device last_seen_at and firmware_version', () => {
    const { db, submit, scan, deviceId } = setup();
    submit([scan('A1B2C3D4', '2026-11-23T08:05:00+08:00')]);
    const device = db.Devices.find((d) => d.device_id === deviceId);
    assert.deepEqual([device.last_seen_at, device.firmware_version], ['2026-11-23T08:10:00+08:00', '0.3.0']);
  });

  it('roster_version comes from Settings', () => {
    const { db, submit, scan } = setup();
    db.Settings.find((s) => s.key === 'roster_version').value = '12';
    assert.equal(submit([scan('A1B2C3D4', '2026-11-23T08:05:00+08:00')]).roster_version, 12);
  });

  it('lcd_line2 is at most 16 characters', () => {
    const { db, submit, scan } = setup();
    db.Students[0].last_name = 'Dela Cruz-Villanueva';
    const [r] = submit([scan('A1B2C3D4', '2026-11-23T08:05:00+08:00')]).results;
    assert.equal(r.lcd_line2, 'C. Dela Cruz-Vil');
  });
});

describe('device.submitScans: duplicates and retries', () => {
  it('second tap of the same student in the same session is DUPLICATE (same batch and a later request)', () => {
    const { db, submit, scan, counts } = setup();
    const data = submit([scan('A1B2C3D4', '2026-11-23T08:05:00+08:00'), scan('A1B2C3D4', '2026-11-23T08:06:00+08:00')]);
    assert.deepEqual(results(data), ['ACCEPTED', 'DUPLICATE']);
    assert.equal(data.results[1].lcd_line2, 'C. Santos');
    assert.equal(data.results[1].attendance_status, '');
    const later = submit([scan('A1B2C3D4', '2026-11-23T08:09:00+08:00')]);
    assert.deepEqual(results(later), ['DUPLICATE']);
    assert.equal(db.Attendance.filter((a) => a.session_id === 'SES-0003').length, 1);
    assert.equal(counts()[2], 3, 'every scan gets a ScanLog row');
    assert.equal(db.ScanLog.at(-1).session_id, 'SES-0003');
  });

  it('two students first-tapping an unopened session share ONE new session', () => {
    const { db, submit, scan } = setup();
    const data = submit([scan('A1B2C3D4', '2026-11-23T08:01:00+08:00'), scan('04000002', '2026-11-23T08:02:00+08:00')]);
    assert.deepEqual(results(data), ['ACCEPTED', 'ACCEPTED']);
    assert.equal(db.ClassSessions.filter((s) => s.session_date === '2026-11-23').length, 1);
    assert.deepEqual(db.Attendance.slice(-2).map((a) => a.session_id), ['SES-0003', 'SES-0003']);
  });

  it('a resent scan_id is ALREADY_RECORDED with the original result, and adds no rows', () => {
    const { submit, scan, counts } = setup();
    const s = scan('A1B2C3D4', '2026-11-23T08:05:00+08:00');
    submit([s]);
    const before = counts();
    const data = submit([s]);
    assert.deepEqual(data.results, [{
      scan_id: s.scan_id, result: 'ALREADY_RECORDED', original_result: 'ACCEPTED', attendance_status: 'PRESENT', final: true, lcd_line2: 'C. Santos',
    }]);
    assert.deepEqual(counts(), before);
  });

  it('the same scan_id twice in one batch: the second is ALREADY_RECORDED, one ScanLog row', () => {
    const { db, submit, scan } = setup();
    const s = scan('ffff0000', '2026-11-23T08:05:00+08:00');
    const data = submit([s, s]);
    assert.deepEqual(results(data), ['UNREGISTERED', 'ALREADY_RECORDED']);
    assert.equal(data.results[1].original_result, 'UNREGISTERED');
    assert.equal(db.ScanLog.filter((l) => l.scan_id === s.scan_id).length, 1);
  });
});

describe('device.submitScans: offline batch', () => {
  it('a batch of 5 from yesterday lands in the right sessions, in order', () => {
    const { db, submit, scan } = setup('2026-11-24T10:30:00+08:00'); // Tuesday
    const off = { sync_mode: 'offline' };
    const data = submit([
      scan('A1B2C3D4', '2026-11-23T08:05:00+08:00', off),
      scan('04000002', '2026-11-23T08:06:00+08:00', off),
      scan('A1B2C3D4', '2026-11-23T08:20:00+08:00', off),
      scan('04000003', '2026-11-23T09:00:00+08:00', off),
      scan('04000004', '2026-11-23T13:05:00+08:00', off),
    ]);
    assert.deepEqual(results(data), ['ACCEPTED', 'ACCEPTED', 'DUPLICATE', 'ACCEPTED', 'ACCEPTED']);
    const made = db.ClassSessions.filter((s) => s.session_date === '2026-11-23');
    assert.deepEqual(made.map((s) => [s.session_id, s.class_id, s.schedule_id]), [['SES-0003', 'CLS-0001', 'SCH-0001'], ['SES-0004', 'CLS-0002', 'SCH-0003']]);
    const att = db.Attendance.filter((a) => a.scanned_at.startsWith('2026-11-23'));
    assert.deepEqual(att.map((a) => [a.student_id, a.session_id, a.sync_mode]), [
      ['STU-0001', 'SES-0003', 'offline'], ['STU-0002', 'SES-0003', 'offline'], ['STU-0003', 'SES-0003', 'offline'], ['STU-0004', 'SES-0004', 'offline'],
    ]);
    assert.ok(att.every((a) => a.received_at === '2026-11-24T10:30:00+08:00'));
  });
});

describe('device.submitScans: rejected scans (each still gets a ScanLog row)', () => {
  it('unknown UID: UNREGISTERED, logged, and shown in the admin unregistered-UID list', () => {
    const { db, submit, scan, counts } = setup();
    const before = counts();
    const [r] = submit([scan('de:ad:be:ef', '2026-11-23T08:05:00+08:00')]).results;
    assert.deepEqual([r.result, r.attendance_status, r.final, r.lcd_line2], ['UNREGISTERED', '', true, '']);
    assert.deepEqual(counts(), [before[0], before[1], before[2] + 1]);
    assert.deepEqual([db.ScanLog.at(-1).rfid_uid, db.ScanLog.at(-1).result, db.ScanLog.at(-1).student_id], ['DEADBEEF', 'UNREGISTERED', '']);
    const listed = listUnregisteredUids(db, {}, SESSIONS.admin, makeCtx());
    assert.ok(JSON.stringify(listed).includes('DEADBEEF'));
  });

  it('a revoked card is UNREGISTERED', () => {
    const { db, submit, scan } = setup();
    db.RfidCards[0].status = 'revoked';
    assert.deepEqual(results(submit([scan('A1B2C3D4', '2026-11-23T08:05:00+08:00')])), ['UNREGISTERED']);
  });

  it('an active card of an inactive student is UNREGISTERED', () => {
    const { db, submit, scan } = setup();
    db.Students[0].account_status = 'inactive';
    assert.deepEqual(results(submit([scan('A1B2C3D4', '2026-11-23T08:05:00+08:00')])), ['UNREGISTERED']);
  });

  it('NOT_ENROLLED: STU-0004 taps during CLS-0001', () => {
    const { db, submit, scan, counts } = setup();
    const before = counts();
    assert.deepEqual(results(submit([scan('04000004', '2026-11-23T08:05:00+08:00')])), ['NOT_ENROLLED']);
    assert.deepEqual(counts(), [before[0], before[1], before[2] + 1]);
    assert.deepEqual([db.ScanLog.at(-1).student_id, db.ScanLog.at(-1).session_id], ['STU-0004', '']);
  });

  it('NO_ACTIVE_SESSION: no class in the room at 11:00', () => {
    const { submit, scan } = setup('2026-11-23T11:05:00+08:00');
    assert.deepEqual(results(submit([scan('A1B2C3D4', '2026-11-23T11:00:00+08:00')])), ['NO_ACTIVE_SESSION']);
  });

  it('SESSION_CANCELLED', () => {
    const { db, submit, scan } = setup();
    db.ClassSessions.push({ ...db.ClassSessions[0], session_id: 'SES-0003', session_date: '2026-11-23', status: 'cancelled' });
    assert.deepEqual(results(submit([scan('A1B2C3D4', '2026-11-23T08:05:00+08:00')])), ['SESSION_CANCELLED']);
  });

  it('INVALID_TIME: unverified, scanned_at 0, or far in the future; ScanLog keeps the student when the UID resolves', () => {
    const { db, submit, scan, counts } = setup();
    const before = counts();
    const data = submit([
      scan('A1B2C3D4', '2026-11-23T08:05:00+08:00', { time_quality: 'unverified' }),
      { ...scan('A1B2C3D4', MON_0810), scanned_at: 0, time_quality: 'unverified' },
      scan('A1B2C3D4', '2026-11-23T08:20:00+08:00'), // 10 min ahead of the server clock
      scan('ffff0001', '2026-11-23T08:05:00+08:00', { time_quality: 'unverified' }),
      { ...scan('ffff0002', MON_0810), scanned_at: 0 }, // time check comes before the UID check
    ]);
    assert.deepEqual(results(data), ['INVALID_TIME', 'INVALID_TIME', 'INVALID_TIME', 'INVALID_TIME', 'INVALID_TIME']);
    assert.deepEqual(counts(), [before[0], before[1], before[2] + 5]);
    assert.deepEqual(db.ScanLog.slice(-5).map((l) => l.student_id), ['STU-0001', 'STU-0001', 'STU-0001', '', '']);
    assert.equal(db.ScanLog.at(-4).scanned_at, '', 'scanned_at 0 is stored as blank');
  });
});

describe('device.submitScans: request validation (BAD_REQUEST, nothing saved)', () => {
  const bad = (mutate) => () => {
    const { db, submit, scan } = setup();
    const before = JSON.stringify(db);
    const scans = [scan('A1B2C3D4', '2026-11-23T08:05:00+08:00')];
    const extra = mutate(scans) || {};
    assert.throws(() => submit(scans, extra), withCode('BAD_REQUEST'));
    assert.equal(JSON.stringify(db), before);
  };

  it('20 scans are fine: 20 results in request order', () => {
    const { submit, scan } = setup();
    const scans = Array.from({ length: 20 }, (_, i) => scan(`ffff${String(i).padStart(4, '0')}`, '2026-11-23T08:05:00+08:00'));
    const data = submit(scans);
    assert.deepEqual(data.results.map((r) => r.scan_id), scans.map((s) => s.scan_id));
  });

  it('21 scans', bad((scans) => { while (scans.length < 21) scans.push({ ...scans[0], scan_id: `${scans[0].scan_id.slice(0, -6)}${String(scans.length + 1).padStart(6, '0')}` }); }));
  it('0 scans', bad((scans) => { scans.length = 0; }));
  it('scans is not an array', bad(() => ({ scans: 'x' })));
  it('a later bad item fails the whole request', bad((scans) => { scans.push({ ...scans[0], scan_id: `${scans[0].scan_id.slice(0, -1)}9`, rfid_uid: 'XYZ' }); }));
  it('rfid_uid with a wrong length', bad((scans) => { scans[0].rfid_uid = 'A1B2C3'; }));
  it('scan_id of another device', bad((scans) => { scans[0].scan_id = 'DEV-CPE-102-01-000001-000001'; }));
  it('scan_id in the wrong shape', bad((scans) => { scans[0].scan_id = scans[0].scan_id.slice(0, -1); }));
  it('scanned_at not an integer', bad((scans) => { scans[0].scanned_at = '1793750710'; }));
  it('scanned_at negative', bad((scans) => { scans[0].scanned_at = -5; }));
  it('unknown time_quality', bad((scans) => { scans[0].time_quality = 'gps'; }));
  it('unknown sync_mode', bad((scans) => { scans[0].sync_mode = 'later'; }));
  it('sent_at missing', bad(() => ({ sent_at: undefined })));

  it('a UID with colons/spaces/lowercase is normalized, not rejected', () => {
    const { db, submit, scan } = setup();
    assert.deepEqual(results(submit([scan(' a1:b2 c3-d4 ', '2026-11-23T08:05:00+08:00')])), ['ACCEPTED']);
    assert.equal(db.ScanLog.at(-1).rfid_uid, 'A1B2C3D4');
  });
});

describe('device.submitScans: device auth', () => {
  it('wrong key: INVALID_DEVICE_KEY and nothing written', () => {
    const { db, ctx, request, scan } = setup();
    const before = JSON.stringify(db);
    const body = request([scan('A1B2C3D4', '2026-11-23T08:05:00+08:00')], { device_key: 'f'.repeat(64) });
    assert.throws(() => runDeviceAction(db, body, ctx), withCode('INVALID_DEVICE_KEY'));
    assert.equal(JSON.stringify(db), before);
  });

  it('a device in maintenance: DEVICE_DISABLED', () => {
    const { db, ctx, request, scan, deviceId } = setup();
    db.Devices.find((d) => d.device_id === deviceId).status = 'maintenance';
    assert.throws(() => runDeviceAction(db, request([scan('A1B2C3D4', MON_0810)]), ctx), withCode('DEVICE_DISABLED'));
  });

  it('runs on a db holding only its declared tabs', () => {
    const { db, ctx, request, scan } = setup();
    const spec = deviceTabsFor('device.submitScans');
    const only = {};
    [...spec.read, ...spec.append].forEach((tab) => { only[tab] = db[tab]; });
    const guarded = guardDb(only, spec, (tab) => { throw new Error(`undeclared ${tab}`); });
    const data = runDeviceAction(guarded, request([scan('A1B2C3D4', '2026-11-23T08:05:00+08:00'), scan('ffff0000', '2026-11-23T08:05:00+08:00')]), ctx);
    assert.deepEqual(results(data), ['ACCEPTED', 'UNREGISTERED']);
  });

  it('an unknown device.* action is still UNKNOWN_ACTION after the key check', () => {
    const { db, ctx, request } = setup();
    assert.throws(() => runDeviceAction(db, { ...request([]), action: 'device.nope' }, ctx), withCode('UNKNOWN_ACTION'));
    assert.deepEqual(deviceTabsFor('device.nope'), { read: ['Devices'], write: [], append: [] });
  });
});

describe('device.submitScans end to end', () => {
  it('tap -> instructor.getSession shows the student present -> student.getHistory shows it', () => {
    const { db, ctx, submit, scan } = setup('2026-11-23T08:30:00+08:00');
    submit([scan('A1B2C3D4', '2026-11-23T08:05:00+08:00')]);
    const sessionId = db.ClassSessions.at(-1).session_id;
    const login = (userId) => startSession(db, db.Users.find((u) => u.user_id === userId), ctx).token;

    const view = runAction(db, { action: 'instructor.getSession', session_token: login('USR-0002'), session_id: sessionId }, ctx);
    const carla = view.students.find((s) => s.student_id === 'STU-0001');
    assert.deepEqual([carla.status, carla.source, carla.sync_mode, view.session.phase], ['present', 'device', 'live', 'in_progress']);
    assert.equal(view.students.find((s) => s.student_id === 'STU-0002').status, 'not_scanned');

    const history = runAction(db, { action: 'student.getHistory', session_token: login('USR-0004') }, ctx);
    const record = history.records.find((r) => r.session_id === sessionId);
    assert.equal(record.status, 'present');
  });
});
