// SFIX-05: a student sees why, when and by which ROLE a record was corrected,
// never the corrector's user id or name.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, SESSIONS, CTX } from './helpers/db.js';
import * as portal from '../src/handlers/portal.js';
import { adminCorrectAttendance } from '../src/handlers/attendance.js';

const req = { session_id: 'SES-0001', student_id: 'STU-0001', status: 'late', reason: 'came in after the quiz' };
const ownRow = (db) => portal.studentHistory(db, {}, SESSIONS.student1, CTX).records.find((r) => r.session_id === 'SES-0001');
const AT = '2026-11-20T12:00:00+08:00';

describe('student history shows the correction', () => {
  it('instructor override: reason, when, role Instructor; no user id or name', () => {
    const db = makeDb();
    portal.instructorCorrectAttendance(db, req, SESSIONS.instructorAna, CTX);
    const row = ownRow(db);
    assert.equal(row.corrected, true);
    assert.deepEqual(row.correction, { reason: 'came in after the quiz', at: AT, by_role: 'Instructor' });
    const text = JSON.stringify(row);
    assert.ok(!text.includes('USR-'), 'leaks a user id');
    assert.ok(!/ana/i.test(text), 'leaks the instructor name');
  });

  it('admin override: role Admin', () => {
    const db = makeDb();
    adminCorrectAttendance(db, req, SESSIONS.admin, CTX);
    assert.deepEqual(ownRow(db).correction, { reason: 'came in after the quiz', at: AT, by_role: 'Admin' });
  });

  it('manual row (no tap) added by an instructor: role Instructor, when = received_at', () => {
    const db = makeDb();
    db.Attendance = db.Attendance.filter((a) => !(a.session_id === 'SES-0001' && a.student_id === 'STU-0001'));
    portal.instructorCorrectAttendance(db, { ...req, status: 'present' }, SESSIONS.instructorAna, CTX);
    const row = ownRow(db);
    assert.equal(row.manual, true);
    assert.deepEqual(row.correction, { reason: 'came in after the quiz', at: AT, by_role: 'Instructor' });
  });

  it('uncorrected row: correction is null', () => {
    const row = ownRow(makeDb());
    assert.equal(row.corrected, false);
    assert.equal(row.correction, null);
  });
});
