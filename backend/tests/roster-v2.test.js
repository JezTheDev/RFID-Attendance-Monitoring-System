// Stage 2: device.getRoster v2 (Device_API_Spec 6.3 v0.3): cards + the tap
// windows of the device's room for the next 48 h, versioned by a content hash.
// Fixture: helpers/db.js; device in RM-0001; NOW = Monday 2026-11-23 08:10 Manila;
// CLS-0001 "CPE301 3A" meets MON 08:00-10:00 in RM-0001 (STU-0001..3, only STU-0001 has a card);
// CLS-0002 meets TUE 08:00-10:00 in RM-0002 (another room).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, SESSIONS } from './helpers/db.js';
import { makeCtx } from './helpers/auth.js';
import { createDevice, generateDeviceKey, setDeviceStatus } from '../src/handlers/devices.js';
import { runDeviceAction } from '../src/actions.js';

const NOW = '2026-11-23T08:10:00+08:00';
const epoch = (iso) => Date.parse(iso) / 1000;

function setup() {
  const db = makeDb();
  const ctx = makeCtx({ startMs: Date.parse(NOW) });
  db.Settings.push(
    { key: 'duplicate_window_minutes', value: '7', description: '', source: '' },
    { key: 'heartbeat_interval_seconds', value: '120', description: '', source: '' },
  );
  const deviceId = createDevice(db, { device_name: 'Lab 1 Reader', room_id: 'RM-0001' }, SESSIONS.admin, ctx).device_id;
  const key = generateDeviceKey(db, { device_id: deviceId }, SESSIONS.admin, ctx).device_key;
  setDeviceStatus(db, { device_id: deviceId, status: 'active' }, SESSIONS.admin, ctx);
  const roster = (extra = {}) => runDeviceAction(db, { action: 'device.getRoster', device_id: deviceId, device_key: key, known_version: '', ...extra }, ctx);
  const card = (n, studentId, status = 'active') => db.RfidCards.push({
    card_id: `CRD-00${n}`, rfid_uid: `0400000${n}`, student_id: studentId, status, assigned_at: '', revoked_at: '', notes: '',
  });
  const row = () => db.Devices.find((d) => d.device_id === deviceId);
  return { db, ctx, roster, card, row, key };
}

function addClass(db, classId, start, end, { room = 'RM-0001', day = 'MON', students = [] } = {}) {
  db.Classes.push({ ...db.Classes[0], class_id: classId, class_label: classId });
  db.Schedules.push({ schedule_id: `SCH-${classId}`, class_id: classId, room_id: room, day_of_week: day, start_time: start, end_time: end, status: 'active' });
  students.forEach((id) => db.Enrollments.push({ enrollment_id: `ENR-${classId}-${id}`, class_id: classId, student_id: id, status: 'enrolled', enrolled_at: '' }));
}

const codeOf = (fn) => { try { fn(); } catch (error) { return error.code; } return 'NO_ERROR'; };

describe('device.getRoster v2: response shape', () => {
  it('changed:true with string version, generated_at, valid_until = +48 h, settings, cards, windows', () => {
    const { roster } = setup();
    const data = roster();
    assert.equal(data.changed, true);
    assert.match(data.roster_version, /^[0-9a-f]{16}$/);
    assert.equal(data.generated_at, epoch(NOW));
    assert.equal(data.valid_until, epoch(NOW) + 48 * 3600);
    assert.deepEqual(data.settings, { duplicate_window_minutes: 7, roster_refresh_seconds: 120 });
    assert.deepEqual(data.cards, [{ uid: 'A1B2C3D4', name: 'C. Santos' }]);
  });

  it('known_version == current → changed:false and the version only', () => {
    const { roster } = setup();
    const { roster_version: version } = roster();
    assert.deepEqual(roster({ known_version: version }), { changed: false, roster_version: version });
  });

  it('wrong device key → INVALID_DEVICE_KEY', () => {
    const { roster } = setup();
    assert.equal(codeOf(() => roster({ device_key: 'f'.repeat(64) })), 'INVALID_DEVICE_KEY');
  });
});

describe('device.getRoster v2: windows', () => {
  it('only this device\'s room (CLS-0002 on Tuesday is in RM-0002)', () => {
    const { roster } = setup();
    assert.deepEqual(roster().windows.map((w) => w.label), ['CPE301 3A']);
  });

  it('start = scheduled start - 15 min, end = scheduled end (epoch seconds); a window in progress is listed', () => {
    const { roster } = setup();
    const [w] = roster().windows;
    assert.deepEqual([w.start, w.end, w.cancelled], [epoch('2026-11-23T07:45:00+08:00'), epoch('2026-11-23T10:00:00+08:00'), false]);
  });

  it('uids = active cards of enrolled, active students; revoked cards and inactive students excluded', () => {
    const { db, roster, card } = setup();
    card(2, 'STU-0002', 'revoked');
    card(3, 'STU-0003');
    card(4, 'STU-0004'); // has a card, but not enrolled in CLS-0001
    db.Students.find((s) => s.student_id === 'STU-0003').account_status = 'inactive';
    const data = roster();
    assert.deepEqual(data.cards.map((c) => c.uid), ['A1B2C3D4', '04000004']);
    assert.deepEqual(data.windows[0].uids, ['A1B2C3D4']);
  });

  it('a cancelled session is listed with cancelled:true', () => {
    const { db, roster } = setup();
    db.ClassSessions.push({ ...db.ClassSessions[0], session_id: 'SES-0099', session_date: '2026-11-23', status: 'cancelled' });
    assert.deepEqual(roster().windows.map((w) => [w.label, w.cancelled]), [['CPE301 3A', true]]);
  });

  it('enrolled_at: joined during the session counts; joined after the session ended does not', () => {
    const { db, roster, card } = setup();
    card(2, 'STU-0002');
    card(3, 'STU-0003');
    db.Enrollments.find((e) => e.student_id === 'STU-0002').enrolled_at = '2026-11-23T08:05:00+08:00';
    db.Enrollments.find((e) => e.student_id === 'STU-0003').enrolled_at = '2026-11-23T10:01:00+08:00';
    assert.deepEqual(roster().windows[0].uids, ['A1B2C3D4', '04000002']);
  });

  it('back-to-back classes give two overlapping windows, sorted by start', () => {
    const { db, roster } = setup();
    addClass(db, 'CLS-0003', '10:00', '12:00', { students: ['STU-0001'] });
    const windows = roster().windows;
    assert.deepEqual(windows.map((w) => w.label), ['CPE301 3A', 'CLS-0003']);
    assert.equal(windows[1].start, epoch('2026-11-23T09:45:00+08:00'));
    assert.ok(windows[1].start < windows[0].end);
  });

  it('48 h: includes a window on the third date that starts before now+48h; excludes one that ended before now', () => {
    const { db, roster } = setup();
    addClass(db, 'CLS-WED', '08:00', '09:00', { day: 'WED' }); // starts 07:45 Wed < 08:10 Wed
    addClass(db, 'CLS-WED2', '08:30', '09:00', { day: 'WED' }); // 08:15 Wed > now+48h
    addClass(db, 'CLS-EARLY', '06:00', '07:00'); // ended today before 08:10
    assert.deepEqual(roster().windows.map((w) => w.label), ['CPE301 3A', 'CLS-WED']);
  });

  it('manual sessions in the room are listed (cancelled ones as cancelled)', () => {
    const { db, roster } = setup();
    const manual = { ...db.ClassSessions[0], schedule_id: '', source: 'manual', session_date: '2026-11-24', scheduled_start: '13:00', scheduled_end: '14:00', status: 'open' };
    db.ClassSessions.push({ ...manual, session_id: 'SES-0098' }, { ...manual, session_id: 'SES-0099', scheduled_start: '15:00', scheduled_end: '16:00', status: 'cancelled' });
    assert.deepEqual(roster().windows.map((w) => [w.label, w.start, w.cancelled]).slice(1), [
      ['CPE301 3A', epoch('2026-11-24T12:45:00+08:00'), false],
      ['CPE301 3A', epoch('2026-11-24T14:45:00+08:00'), true],
    ]);
  });

  it('no active term → no windows', () => {
    const { db, roster } = setup();
    db.Terms[0].is_active = 'FALSE';
    assert.deepEqual(roster().windows, []);
  });
});

describe('device.getRoster v2: roster_version', () => {
  it('same data → same version, even when the clock moves (no window starts or ends)', () => {
    const { ctx, roster } = setup();
    const before = roster().roster_version;
    ctx.clock.ms += 60 * 1000;
    assert.equal(roster().roster_version, before);
  });

  const changes = {
    'card assigned': (db) => db.RfidCards.push({ card_id: 'CRD-0009', rfid_uid: '04000009', student_id: 'STU-0002', status: 'active' }),
    'card revoked': (db) => { db.RfidCards[0].status = 'revoked'; },
    'schedule time': (db) => { db.Schedules[0].start_time = '08:30'; },
    'enrollment dropped': (db) => { db.Enrollments.find((e) => e.student_id === 'STU-0001').status = 'dropped'; },
    'session cancelled': (db) => db.ClassSessions.push({ ...db.ClassSessions[0], session_id: 'SES-0099', session_date: '2026-11-23', status: 'cancelled' }),
    'duplicate window setting': (db) => { db.Settings.find((s) => s.key === 'duplicate_window_minutes').value = '9'; },
    'early window setting': (db) => db.Settings.push({ key: 'early_window_minutes', value: '10' }),
  };
  Object.entries(changes).forEach(([name, change]) => {
    it(`${name} → new version`, () => {
      const { db, roster } = setup();
      const before = roster().roster_version;
      change(db);
      const after = roster({ known_version: before });
      assert.equal(after.changed, true);
      assert.notEqual(after.roster_version, before);
    });
  });
});

describe('device.getRoster v2: last-seen info', () => {
  it('stores firmware_version, queue_count and last_seen_at', () => {
    const { roster, row } = setup();
    roster({ firmware_version: ' 0.5.0 ', queue_count: 3 });
    assert.deepEqual([row().firmware_version, row().queue_count, row().last_seen_at], ['0.5.0', '3', NOW]);
  });

  it('bad or missing values are ignored, never an error', () => {
    const { roster, row } = setup();
    roster({ firmware_version: '0.5.0', queue_count: 2 });
    roster({ firmware_version: 'x'.repeat(33), queue_count: -1 });
    roster({ firmware_version: undefined, queue_count: 1.5 });
    assert.deepEqual([row().firmware_version, row().queue_count], ['0.5.0', '2']);
  });
});
