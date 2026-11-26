// Step 4e: device.heartbeat and device.getRoster (Device_API_Spec 6.2, 6.3),
// and roster_version bumps. Fixture: helpers/db.js + one active device in RM-0001
// and a second device (untouched) to prove heartbeat changes only its own row.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, SESSIONS } from './helpers/db.js';
import { makeCtx } from './helpers/auth.js';
import { createDevice, generateDeviceKey, setDeviceStatus } from '../src/handlers/devices.js';
import { getAdminDashboard } from '../src/handlers/dashboard.js';
import { runDeviceAction } from '../src/actions.js';
import { assignCard, revokeCard, setStudentStatus, updateStudent } from '../src/handlers/students.js';

const NOW = '2026-11-23T08:10:00+08:00';

function setup() {
  const db = makeDb();
  const ctx = makeCtx({ startMs: Date.parse(NOW) });
  db.Settings.push(
    { key: 'low_battery_voltage', value: '3.5', description: '', source: '' },
    { key: 'duplicate_window_minutes', value: '7', description: '', source: '' },
    { key: 'heartbeat_interval_seconds', value: '120', description: '', source: '' },
  );
  const other = createDevice(db, { device_name: 'Lab 2 Reader', room_id: 'RM-0002' }, SESSIONS.admin, ctx).device_id;
  const deviceId = createDevice(db, { device_name: 'Lab 1 Reader', room_id: 'RM-0001' }, SESSIONS.admin, ctx).device_id;
  const key = generateDeviceKey(db, { device_id: deviceId }, SESSIONS.admin, ctx).device_key;
  setDeviceStatus(db, { device_id: deviceId, status: 'active' }, SESSIONS.admin, ctx);
  const beat = (extra = {}) => runDeviceAction(db, {
    action: 'device.heartbeat', device_id: deviceId, device_key: key, sent_at: Math.floor(ctx.now() / 1000),
    battery_voltage: 3.82, wifi_rssi: -61, queue_count: 0, time_synced: true, firmware_version: '0.3.0', uptime_seconds: 5400, ...extra,
  }, ctx);
  const roster = (extra = {}) => runDeviceAction(db, { action: 'device.getRoster', device_id: deviceId, device_key: key, ...extra }, ctx);
  const row = () => db.Devices.find((d) => d.device_id === deviceId);
  return { db, ctx, deviceId, other, key, beat, roster, row };
}

const codeOf = (fn) => { try { fn(); } catch (error) { return error.code; } return 'NO_ERROR'; };

describe('device.heartbeat', () => {
  it('updates only its own device row, no AuditLog row', () => {
    const { db, beat, row, deviceId } = setup();
    const snapshot = (tabs) => JSON.stringify(tabs);
    const othersBefore = snapshot(Object.fromEntries(Object.entries(db).filter(([name]) => name !== 'Devices')));
    const otherDevicesBefore = snapshot(db.Devices.filter((d) => d.device_id !== deviceId));

    const data = beat();

    assert.deepEqual(data, { roster_version: 1, low_battery: false });
    assert.equal(snapshot(Object.fromEntries(Object.entries(db).filter(([name]) => name !== 'Devices'))), othersBefore);
    assert.equal(snapshot(db.Devices.filter((d) => d.device_id !== deviceId)), otherDevicesBefore);
    const r = row();
    assert.deepEqual(
      [r.battery_voltage, r.wifi_rssi, r.queue_count, r.time_synced, r.firmware_version, r.last_heartbeat_at, r.last_seen_at],
      ['3.82', '-61', '0', 'TRUE', '0.3.0', NOW, NOW],
    );
  });

  it('rounds battery_voltage to 2 decimals; stores time_synced false as FALSE', () => {
    const { beat, row } = setup();
    beat({ battery_voltage: 3.8200000001, time_synced: false, firmware_version: ' 0.3.1 ' });
    assert.deepEqual([row().battery_voltage, row().time_synced, row().firmware_version], ['3.82', 'FALSE', '0.3.1']);
  });

  it('bad values → BAD_REQUEST and nothing written', () => {
    const { beat, row } = setup();
    const bad = [
      { battery_voltage: 6.01 }, { battery_voltage: -0.1 }, { battery_voltage: '3.8' }, { battery_voltage: NaN }, { battery_voltage: undefined },
      { wifi_rssi: 1 }, { wifi_rssi: -128 }, { wifi_rssi: -60.5 },
      { queue_count: -1 }, { queue_count: 1.5 },
      { time_synced: 'true' }, { time_synced: 1 },
      { firmware_version: '' }, { firmware_version: '   ' }, { firmware_version: 'x'.repeat(33) }, { firmware_version: 3 },
      { uptime_seconds: -1 }, { uptime_seconds: 1.5 },
    ];
    const before = JSON.stringify(row());
    bad.forEach((extra) => assert.equal(codeOf(() => beat(extra)), 'BAD_REQUEST', JSON.stringify(extra)));
    assert.equal(JSON.stringify(row()), before);
  });

  it('low_battery at the threshold (low_battery_voltage 3.5)', () => {
    const { beat } = setup();
    assert.equal(beat({ battery_voltage: 3.49 }).low_battery, true);
    assert.equal(beat({ battery_voltage: 3.5 }).low_battery, false);
    assert.equal(beat({ battery_voltage: 3.51 }).low_battery, false);
  });

  it('wrong device key → INVALID_DEVICE_KEY (before field checks)', () => {
    const { beat } = setup();
    assert.equal(codeOf(() => beat({ device_key: 'f'.repeat(64) })), 'INVALID_DEVICE_KEY');
    assert.equal(codeOf(() => beat({ device_key: 'f'.repeat(64), battery_voltage: 99 })), 'INVALID_DEVICE_KEY');
  });

  it('admin dashboard shows the heartbeat battery and online status', () => {
    const { db, ctx, beat, deviceId } = setup();
    beat({ battery_voltage: 3.4 });
    const device = getAdminDashboard(db, { date: '2026-11-23' }, SESSIONS.admin, ctx).devices.find((d) => d.device_id === deviceId);
    assert.deepEqual([device.battery_voltage, device.low_battery, device.online], [3.4, true, true]);
  });
});

// v2 contract (windows, hash version): roster-v2.test.js.
describe('device.getRoster', () => {
  it('excludes revoked cards and inactive students', () => {
    const { db, roster } = setup();
    db.RfidCards.push(
      { card_id: 'CRD-0002', rfid_uid: '04000002', student_id: 'STU-0002', status: 'revoked', assigned_at: '', revoked_at: '', notes: '' },
      { card_id: 'CRD-0003', rfid_uid: '04000003', student_id: 'STU-0003', status: 'active', assigned_at: '', revoked_at: '', notes: '' },
      { card_id: 'CRD-0004', rfid_uid: '04000004', student_id: 'STU-0004', status: 'lost', assigned_at: '', revoked_at: '', notes: '' },
    );
    db.Students.find((s) => s.student_id === 'STU-0003').account_status = 'inactive'; // legacy: inactive with an active card
    assert.deepEqual(roster({ known_version: 0 }).cards.map((c) => c.uid), ['A1B2C3D4']);
  });

  it('names are at most 16 characters', () => {
    const { db, roster } = setup();
    Object.assign(db.Students.find((s) => s.student_id === 'STU-0001'), { first_name: 'Maximiliano', last_name: 'Dela Cruz-Villanueva' });
    const { cards } = roster({ known_version: 0 });
    assert.equal(cards[0].name, 'M. Dela Cruz-Vil');
    cards.forEach((c) => assert.ok(c.name.length <= 16, c.name));
  });

  it('wrong device key → INVALID_DEVICE_KEY', () => {
    const { roster } = setup();
    assert.equal(codeOf(() => roster({ device_key: 'f'.repeat(64) })), 'INVALID_DEVICE_KEY');
  });
});

describe('roster_version bumps', () => {
  const version = (db) => Number(db.Settings.find((r) => r.key === 'roster_version').value);
  const stu1 = { student_id: 'STU-0001', student_number: '2024000001', first_name: 'Carla', last_name: 'Santos', section_id: 'SEC-0001', email: 's1@example.com' };
  const actions = {
    'assignCard (new card)': (db, ctx) => assignCard(db, { student_id: 'STU-0002', rfid_uid: '04000002' }, SESSIONS.admin, ctx),
    'assignCard (replace)': (db, ctx) => assignCard(db, { student_id: 'STU-0001', rfid_uid: '04000009', replace_reason: 'lost' }, SESSIONS.admin, ctx),
    revokeCard: (db, ctx) => revokeCard(db, { student_id: 'STU-0001', reason: 'lost card' }, SESSIONS.admin, ctx),
    'setStudentStatus inactive': (db, ctx) => setStudentStatus(db, { student_id: 'STU-0001', status: 'inactive', reason: 'dropped' }, SESSIONS.admin, ctx),
    'setStudentStatus active': (db, ctx) => setStudentStatus(db, { student_id: 'STU-0001', status: 'active', reason: 'returned' }, SESSIONS.admin, ctx),
    'updateStudent (last name)': (db, ctx) => updateStudent(db, { ...stu1, last_name: 'Santos-Reyes' }, SESSIONS.admin, ctx),
    'updateStudent (first name)': (db, ctx) => updateStudent(db, { ...stu1, first_name: 'Karla' }, SESSIONS.admin, ctx),
  };
  Object.entries(actions).forEach(([name, run]) => {
    it(`${name} bumps roster_version and getRoster sees the change`, () => {
      const { db, ctx, roster } = setup();
      // legacy data: an inactive student who kept an active card
      if (name === 'setStudentStatus active') db.Students.find((s) => s.student_id === 'STU-0001').account_status = 'inactive';
      const before = roster({ known_version: 0 });
      run(db, ctx);
      assert.equal(version(db), 2);
      assert.equal(roster({ known_version: 1 }).changed, true);
      assert.notDeepEqual(roster({ known_version: 0 }).cards, before.cards);
    });
  });

  it('updateStudent changing only the email does not bump', () => {
    const { db, ctx } = setup();
    updateStudent(db, { ...stu1, email: 'new@example.com' }, SESSIONS.admin, ctx);
    assert.equal(version(db), 1);
  });
});
