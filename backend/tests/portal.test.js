// Ownership rules for the Instructor and Student portals, and absent counting.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, SESSIONS, withCode } from './helpers/db.js';
import * as portal from '../src/handlers/portal.js';

describe('student can only see their own data', () => {
  it('rejects history for a class the student is not enrolled in', () => {
    const db = makeDb();
    assert.throws(() => portal.studentHistory(db, { class_id: 'CLS-0002' }, SESSIONS.student1), withCode('FORBIDDEN'));
  });

  it('ignores a student_id sent in the request and returns only own records', () => {
    const db = makeDb();
    const result = portal.studentHistory(db, { student_id: 'STU-0004' }, SESSIONS.student1);
    assert.deepEqual(result.classes.map((c) => c.class_id), ['CLS-0001']);
    assert.deepEqual(result.records.map((r) => [r.session_id, r.status]), [['SES-0001', 'present']]);
  });

  it('overview and profile describe the signed-in student only', () => {
    const db = makeDb();
    assert.equal(portal.studentOverview(db, { student_id: 'STU-0001' }, SESSIONS.student4).profile.student_number, '2024000004');
    assert.equal(portal.studentGetProfile(db, { student_id: 'STU-0004' }, SESSIONS.student1).profile.student_number, '2024000001');
  });

  it('rejects a session whose user has a different role', () => {
    const db = makeDb();
    assert.throws(() => portal.studentOverview(db, {}, SESSIONS.instructorAna), withCode('FORBIDDEN'));
  });
});

describe('instructor can only access their own classes', () => {
  it('cannot open a session of another instructor\'s class', () => {
    const db = makeDb();
    assert.throws(() => portal.instructorGetSession(db, { session_id: 'SES-0002' }, SESSIONS.instructorAna), withCode('FORBIDDEN'));
  });

  it('cannot correct attendance in another instructor\'s class, and nothing changes', () => {
    const db = makeDb();
    const before = JSON.stringify(db.Attendance);
    assert.throws(() => portal.instructorCorrectAttendance(db, {
      session_id: 'SES-0002', student_id: 'STU-0004', status: 'absent', reason: 'Not in class',
    }, SESSIONS.instructorAna), withCode('FORBIDDEN'));
    assert.equal(JSON.stringify(db.Attendance), before);
    assert.equal(db.AuditLog.length, 0);
  });

  it('cannot list sessions, roster, or report of another instructor\'s class', () => {
    const db = makeDb();
    const other = { class_id: 'CLS-0002' };
    assert.throws(() => portal.instructorListSessions(db, other, SESSIONS.instructorAna), withCode('FORBIDDEN'));
    assert.throws(() => portal.instructorClassRoster(db, other, SESSIONS.instructorAna), withCode('FORBIDDEN'));
    assert.throws(() => portal.instructorClassReport(db, other, SESSIONS.instructorAna), withCode('FORBIDDEN'));
  });

  it('cannot read the history of a student who is not in their class', () => {
    const db = makeDb();
    assert.throws(() => portal.instructorStudentHistory(db, { class_id: 'CLS-0001', student_id: 'STU-0004' }, SESSIONS.instructorAna), withCode('NOT_ENROLLED'));
  });

  it('dashboard lists only the instructor\'s own classes', () => {
    const db = makeDb();
    const result = portal.instructorDashboard(db, { date: '2026-11-16' }, SESSIONS.instructorAna);
    assert.deepEqual(result.classes.map((c) => c.class_id), ['CLS-0001']);
  });
});

describe('absent = enrolled - (present + late)', () => {
  it('counts the enrolled student with no record as absent', () => {
    const db = makeDb();
    const { session } = portal.instructorGetSession(db, { session_id: 'SES-0001' }, SESSIONS.instructorAna);
    assert.deepEqual(
      { enrolled: session.enrolled, present: session.present, late: session.late, absent: session.absent },
      { enrolled: 3, present: 1, late: 1, absent: 1 },
    );
  });

  it('does not count a dropped student, even if they have a record', () => {
    const db = makeDb();
    db.Attendance.push({ ...db.Attendance[0], attendance_id: 'ATT-00009', student_id: 'STU-0003' });
    db.Enrollments.find((e) => e.student_id === 'STU-0003').status = 'dropped';
    const { session } = portal.instructorGetSession(db, { session_id: 'SES-0001' }, SESSIONS.instructorAna);
    assert.deepEqual(
      { enrolled: session.enrolled, present: session.present, late: session.late, absent: session.absent },
      { enrolled: 2, present: 1, late: 1, absent: 0 },
    );
  });

  it('marks the student without a record as absent in the session list', () => {
    const db = makeDb();
    const { students } = portal.instructorGetSession(db, { session_id: 'SES-0001' }, SESSIONS.instructorAna);
    assert.deepEqual(Object.fromEntries(students.map((s) => [s.student_id, s.status])),
      { 'STU-0001': 'present', 'STU-0002': 'late', 'STU-0003': 'absent' });
  });
});
