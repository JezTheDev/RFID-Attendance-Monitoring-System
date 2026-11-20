// D6: admins correct attendance with the same rules as instructors (one shared core).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, SESSIONS, withCode, CTX } from './helpers/db.js';
import * as portal from '../src/handlers/portal.js';
import { adminCorrectAttendance } from '../src/handlers/attendance.js';

const req = (over = {}) => ({ session_id: 'SES-0001', student_id: 'STU-0001', status: 'late', reason: 'checked with the class', ...over });
const asAdmin = (db, over) => adminCorrectAttendance(db, req(over), SESSIONS.admin, CTX);
const asAna = (db, over) => portal.instructorCorrectAttendance(db, req(over), SESSIONS.instructorAna, CTX);
const snapshot = (db) => JSON.stringify([db.Attendance, db.AuditLog]);

// Same outcome for both roles, ignoring who did it.
function outcome(run, session) {
  const db = makeDb();
  try {
    const result = run(db);
    const strip = (row) => ({ ...row, override_by: '', created_by: '', user_id: '', role: '' });
    return { result, attendance: db.Attendance.map(strip), audit: db.AuditLog.map(strip), by: session.user_id };
  } catch (e) {
    return { code: e.code, fields: e.fields, unchanged: snapshot(db) === snapshot(makeDb()) };
  }
}

describe('admin.correctAttendance (D6)', () => {
  it('admin can correct a class of any instructor', () => {
    const db = makeDb();
    const result = asAdmin(db, { session_id: 'SES-0002', student_id: 'STU-0004', status: 'absent' });
    assert.deepEqual(result, { session_id: 'SES-0002', student_id: 'STU-0004', status: 'absent' });
    const row = db.Attendance.find((a) => a.session_id === 'SES-0002' && a.student_id === 'STU-0004');
    assert.equal(row.status, 'present', 'device field changed');
    assert.equal(row.override_status, 'absent');
    assert.equal(row.override_by, SESSIONS.admin.user_id);
  });

  it('instructor is still blocked on another instructor\'s class', () => {
    const db = makeDb();
    const before = snapshot(db);
    assert.throws(() => asAna(db, { session_id: 'SES-0002', student_id: 'STU-0004', status: 'absent' }), withCode('FORBIDDEN'));
    assert.equal(snapshot(db), before);
  });

  const CASES = [
    ['device row -> late', {}],
    ['device row -> absent', { status: 'absent' }],
    ['no tap -> present (manual row)', { student_id: 'STU-0003', status: 'present' }],
    ['no tap -> absent (BUG-6)', { student_id: 'STU-0003', status: 'absent' }],
    ['same status', { status: 'present' }],
    ['reason missing', { reason: '' }],
    ['reason too short', { reason: 'abc' }],
    ['bad status', { status: 'excused' }],
    ['not enrolled', { student_id: 'STU-0004' }],
    ['unknown session', { session_id: 'SES-9999' }],
  ];
  for (const [name, over] of CASES) {
    it(`same result for admin and instructor: ${name}`, () => {
      const admin = outcome((db) => asAdmin(db, over), SESSIONS.admin);
      const ana = outcome((db) => asAna(db, over), SESSIONS.instructorAna);
      delete admin.by; delete ana.by;
      assert.deepEqual(admin, ana);
    });
  }

  it('reason is required', () => {
    const db = makeDb();
    assert.throws(() => asAdmin(db, { reason: '  ' }), (e) => e.code === 'VALIDATION_ERROR' && Boolean(e.fields.reason));
  });

  it('BUG-6: admin "absent" for a student with no tap is refused and writes nothing', () => {
    const db = makeDb();
    const before = snapshot(db);
    assert.throws(() => asAdmin(db, { student_id: 'STU-0003', status: 'absent' }),
      (e) => e.code === 'VALIDATION_ERROR' && Boolean(e.fields.status));
    assert.equal(snapshot(db), before);
  });

  it('student not enrolled in the session\'s class -> NOT_ENROLLED, nothing written', () => {
    const db = makeDb();
    const before = snapshot(db);
    assert.throws(() => asAdmin(db, { student_id: 'STU-0004' }), withCode('NOT_ENROLLED'));
    assert.equal(snapshot(db), before);
  });

  it('manual row for present with no tap, created_by = admin', () => {
    const db = makeDb();
    asAdmin(db, { student_id: 'STU-0003', status: 'present' });
    const row = db.Attendance.at(-1);
    assert.deepEqual([row.student_id, row.status, row.source, row.created_by], ['STU-0003', 'present', 'manual', SESSIONS.admin.user_id]);
  });

  it('audit row shows role admin', () => {
    const db = makeDb();
    asAdmin(db);
    const audit = db.AuditLog.at(-1);
    assert.deepEqual([audit.action, audit.role, audit.user_id, audit.entity_type],
      [portal.CORRECTION_ACTION, 'admin', SESSIONS.admin.user_id, 'Attendance']);
  });
});
