// Editor-only maintenance jobs (backend/src/maintenance.js).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers/db.js';
import { backfillOverrideReasons, findScheduleClashes } from '../src/maintenance.js';

const audit = (entityId, reason) => ({
  audit_id: 'AUD-0000', timestamp: '', user_id: 'USR-0002', role: 'instructor', action: 'ATTENDANCE_CORRECT',
  entity_type: 'attendance', entity_id: entityId, before_json: '', after_json: '', reason,
});
const manualRow = (id, studentId) => ({
  attendance_id: id, session_id: 'SES-0001', student_id: studentId, source: 'manual', status: 'late', override_status: '', override_reason: '',
});

describe('backfillOverrideReasons', () => {
  it('copies the LAST correction reason into blank override_reason cells, and is idempotent', () => {
    const db = makeDb();
    db.Attendance.push(manualRow('ATT-00004', 'STU-0003'));
    db.AuditLog.push(audit('SES-0001:STU-0003', 'first reason'), audit('SES-0001:STU-0003', 'reader was offline'));
    const lines = backfillOverrideReasons(db);
    assert.equal(db.Attendance.find((a) => a.attendance_id === 'ATT-00004').override_reason, 'reader was offline');
    assert.match(lines.join('\n'), /of 1 Attendance row/);
    const again = JSON.stringify(db.Attendance);
    assert.match(backfillOverrideReasons(db).join('\n'), /Nothing to change/);
    assert.equal(JSON.stringify(db.Attendance), again);
  });

  it('never overwrites an existing reason and ignores other audit actions', () => {
    const db = makeDb();
    db.Attendance.push({ ...manualRow('ATT-00004', 'STU-0003'), override_reason: 'kept' });
    db.AuditLog.push(audit('SES-0001:STU-0003', 'other'), { ...audit('SES-0001:STU-0001', 'not a correction'), action: 'STUDENT_UPDATE' });
    backfillOverrideReasons(db);
    assert.equal(db.Attendance.find((a) => a.attendance_id === 'ATT-00004').override_reason, 'kept');
    assert.ok(!db.Attendance.find((a) => a.attendance_id === 'ATT-00001').override_reason);
  });
});

describe('findScheduleClashes', () => {
  // CLS-0001: MON 08:00-10:00 RM-0001, INS-0001, SEC-0001. CLS-0002: TUE, RM-0002, INS-0002, SEC-0002.
  const moveClass2 = (db, fields) => {
    Object.assign(db.Schedules[1], { day_of_week: 'MON', start_time: '09:00', end_time: '11:00' }, fields.schedule || {});
    Object.assign(db.Classes[1], fields.klass || {});
  };

  it('finds nothing when no active classes overlap', () => {
    assert.deepEqual(findScheduleClashes(makeDb()), []);
  });

  it('reports a shared room, instructor or section, without changing anything', () => {
    const db = makeDb();
    moveClass2(db, { schedule: { room_id: 'RM-0001' }, klass: { instructor_id: 'INS-0001', section_id: 'SEC-0001' } });
    const before = JSON.stringify(db);
    const lines = findScheduleClashes(db);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /CPE301 3A .*CPE302 3B/);
    assert.match(lines[0], /MON/);
    assert.match(lines[0], /room CPE-101/);
    assert.match(lines[0], /instructor Ana Reyes/);
    assert.match(lines[0], /section 3A/);
    assert.equal(JSON.stringify(db), before);
  });

  it('touching times (10:00 end, 10:00 start) are not a clash', () => {
    const db = makeDb();
    moveClass2(db, { schedule: { room_id: 'RM-0001', start_time: '10:00', end_time: '12:00' } });
    assert.deepEqual(findScheduleClashes(db), []);
  });

  for (const [label, change] of [
    ['an inactive class', { klass: { status: 'inactive' } }],
    ['an inactive schedule', { schedule: { status: 'inactive' } }],
    ['another term', { klass: { term_id: 'TRM-0002' } }],
    ['another day', { schedule: { day_of_week: 'TUE' } }],
  ]) {
    it(`ignores ${label}`, () => {
      const db = makeDb();
      moveClass2(db, { schedule: { room_id: 'RM-0001', ...change.schedule }, klass: change.klass });
      assert.deepEqual(findScheduleClashes(db), []);
    });
  }
});
