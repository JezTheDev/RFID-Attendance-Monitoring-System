// Editor-only maintenance jobs (backend/src/maintenance.js).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers/db.js';
import { backfillOverrideReasons } from '../src/maintenance.js';

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
