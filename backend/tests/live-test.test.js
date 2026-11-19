// Step 4f-prep: editor-only helpers that open/close a LIVE TEST schedule slot.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, withCode } from './helpers/db.js';
import { makeCtx } from './helpers/auth.js';
import { prepareLiveTest, cleanupLiveTest, findScheduleClashes } from '../src/maintenance.js';
import { resolveScan } from '../src/sessions.js';

const at = (iso) => Date.parse(iso);
const MON_11 = at('2026-11-23T11:00:00+08:00');

// makeDb() + active cards for STU-0001..0004 and an active device in each room.
function setup(startMs = MON_11, props) {
  const db = makeDb();
  ['B2', 'C3', 'E5'].forEach((uid, i) => db.RfidCards.push({
    card_id: `CRD-000${i + 2}`, rfid_uid: `A1B2C3${uid}`, student_id: `STU-000${i + 2}`, status: 'active', assigned_at: '', revoked_at: '', notes: '',
  }));
  db.Devices.push(
    { device_id: 'DEV-CPE-101-01', room_id: 'RM-0001', device_name: 'A', device_key_hash: 'x', status: 'active' },
    { device_id: 'DEV-CPE-102-01', room_id: 'RM-0002', device_name: 'B', device_key_hash: 'x', status: 'active' },
  );
  return { db, ctx: makeCtx({ startMs, ...(props ? { props } : {}) }) };
}

const cardOf = (db, uid) => db.RfidCards.find((c) => c.rfid_uid === uid && c.status === 'active');
const enrolled = (db, classId, studentId) => db.Enrollments.some((e) => e.class_id === classId && e.student_id === studentId && e.status === 'enrolled');

describe('prepareLiveTest / cleanupLiveTest', () => {
  it('refuses on a non-test Sheet (TEST_SEED_PASSWORD not set)', () => {
    const { db, ctx } = setup(MON_11, { PASSWORD_PEPPER: 'p' });
    assert.throws(() => prepareLiveTest(db, ctx), withCode('NOT_TEST_SHEET'));
    assert.throws(() => cleanupLiveTest(db, ctx), withCode('NOT_TEST_SHEET'));
    assert.equal(db.Schedules.length, 2);
  });

  it('creates an active slot now-10..now+60 for the class with the most carded students', () => {
    const { db, ctx } = setup();
    const r = prepareLiveTest(db, ctx);
    assert.equal(r.class_id, 'CLS-0001');
    assert.deepEqual([r.day_of_week, r.start_time, r.end_time], ['MON', '10:50', '12:00']);
    const row = db.Schedules.find((s) => s.schedule_id === r.schedule_id);
    assert.equal(row.status, 'active');
    assert.equal(row.room_id, r.room_id);
    assert.ok(db.Devices.some((d) => d.room_id === r.room_id && d.status === 'active' && d.device_id === r.device_id));
    assert.ok(db.AuditLog.some((a) => a.action === 'LIVE_TEST_SCHEDULE' && a.entity_id === r.schedule_id));
    assert.deepEqual(r.enrolled_uids.sort(), ['A1B2C3B2', 'A1B2C3C3', 'A1B2C3D4']);
    r.enrolled_uids.forEach((uid) => assert.ok(enrolled(db, r.class_id, cardOf(db, uid).student_id)));
    assert.ok(!enrolled(db, r.class_id, cardOf(db, r.not_enrolled_uid).student_id));
    assert.ok(!db.RfidCards.some((c) => c.rfid_uid === r.unknown_uid));
    assert.equal(r.reused, false);
  });

  it('the device then ACCEPTs an enrolled tap and says NOT_ENROLLED for the other card', () => {
    const { db, ctx } = setup();
    const r = prepareLiveTest(db, ctx);
    const tap = (uid) => resolveScan(db, { room_id: r.room_id, scanned_at: MON_11 / 1000, student_id: cardOf(db, uid).student_id }, {}, MON_11);
    assert.equal(tap(r.enrolled_uids[0]).result, 'ACCEPTED');
    assert.equal(tap(r.enrolled_uids[0]).class_id, r.class_id);
    assert.equal(tap(r.not_enrolled_uid).result, 'NOT_ENROLLED');
  });

  it('passes the clash check', () => {
    const { db, ctx } = setup();
    const before = findScheduleClashes(db);
    prepareLiveTest(db, ctx);
    assert.deepEqual(findScheduleClashes(db), before);
  });

  it('never double-books: while CLS-0001 meets in RM-0001 it picks another class and room', () => {
    const { db, ctx } = setup(at('2026-11-23T09:00:00+08:00'));
    const r = prepareLiveTest(db, ctx);
    assert.notEqual(r.room_id, 'RM-0001');
    assert.notEqual(r.class_id, 'CLS-0001');
    assert.deepEqual(findScheduleClashes(db), []);
  });

  it('clamps the slot near midnight', () => {
    let { db, ctx } = setup(at('2026-11-23T23:30:00+08:00'));
    assert.equal(prepareLiveTest(db, ctx).end_time, '23:59');
    ({ db, ctx } = setup(at('2026-11-23T00:05:00+08:00')));
    assert.equal(prepareLiveTest(db, ctx).start_time, '00:00');
  });

  it('is idempotent: a second run reuses the slot and writes nothing', () => {
    const { db, ctx } = setup();
    const first = prepareLiveTest(db, ctx);
    const sizes = [db.Schedules.length, db.AuditLog.length];
    ctx.clock.ms += 20 * 60000;
    const second = prepareLiveTest(db, ctx);
    assert.equal(second.reused, true);
    assert.equal(second.schedule_id, first.schedule_id);
    assert.deepEqual([db.Schedules.length, db.AuditLog.length], sizes);
  });

  it('replaces a stale slot (other day) with a new one', () => {
    const { db, ctx } = setup();
    const old = prepareLiveTest(db, ctx);
    ctx.clock.ms = at('2026-11-24T15:00:00+08:00');
    const fresh = prepareLiveTest(db, ctx);
    assert.notEqual(fresh.schedule_id, old.schedule_id);
    assert.equal(fresh.day_of_week, 'TUE');
    assert.equal(db.Schedules.find((s) => s.schedule_id === old.schedule_id).status, 'inactive');
  });

  it('cleanup deactivates LIVE TEST slots only and never deletes rows', () => {
    const { db, ctx } = setup();
    const r = prepareLiveTest(db, ctx);
    db.Attendance.push({ attendance_id: 'ATT-00004', session_id: 'SES-0003', student_id: 'STU-0001' });
    const sizes = () => [db.Schedules.length, db.Attendance.length, db.ScanLog.length];
    const before = sizes();
    const lines = cleanupLiveTest(db, ctx);
    assert.match(lines.join('\n'), new RegExp(r.schedule_id));
    assert.equal(db.Schedules.find((s) => s.schedule_id === r.schedule_id).status, 'inactive');
    assert.equal(db.Schedules.find((s) => s.schedule_id === 'SCH-0001').status, 'active');
    assert.deepEqual(sizes(), before);
    assert.match(cleanupLiveTest(db, ctx)[0], /Nothing to change/);
  });

  it('NO_LIVE_TEST_SLOT when no active term covers today', () => {
    const { db, ctx } = setup(at('2027-02-01T11:00:00+08:00'));
    assert.throws(() => prepareLiveTest(db, ctx), withCode('NO_LIVE_TEST_SLOT'));
  });
});
