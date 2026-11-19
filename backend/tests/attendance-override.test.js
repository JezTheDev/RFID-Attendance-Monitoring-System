// BUG-1: corrections never delete or rewrite an Attendance row. They set
// override_status (+ by/at/reason); everything counts the effective status.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, SESSIONS, withCode } from './helpers/db.js';
import * as portal from '../src/handlers/portal.js';
import { getAdminDashboard } from '../src/handlers/dashboard.js';
import { getStudent } from '../src/handlers/students.js';
import { makeCtx } from './helpers/auth.js';

const DEVICE_FIELDS = ['attendance_id', 'status', 'scanned_at', 'scan_id', 'device_id', 'card_id', 'source'];
const correct = (db, studentId, status, reason = 'checked with the class') =>
  portal.instructorCorrectAttendance(db, { session_id: 'SES-0001', student_id: studentId, status, reason }, SESSIONS.instructorAna);

describe('attendance override (BUG-1)', () => {
  it('Absent override keeps the row and every device field', () => {
    const db = makeDb();
    const row = db.Attendance.find((a) => a.attendance_id === 'ATT-00001');
    const original = Object.fromEntries(DEVICE_FIELDS.map((k) => [k, row[k]]));
    const count = db.Attendance.length;
    correct(db, 'STU-0001', 'absent', 'card used by a friend');
    assert.equal(db.Attendance.length, count);
    assert.ok(db.Attendance.includes(row));
    assert.deepEqual(Object.fromEntries(DEVICE_FIELDS.map((k) => [k, row[k]])), original);
    assert.equal(row.override_status, 'absent');
    assert.equal(row.override_by, SESSIONS.instructorAna.user_id);
    assert.equal(row.override_reason, 'card used by a friend');
    assert.match(row.override_at, /\+08:00$/);
    const audit = db.AuditLog.at(-1);
    assert.deepEqual([JSON.parse(audit.before_json).status, JSON.parse(audit.after_json).status], ['present', 'absent']);
  });

  it('override back to Present works and keeps the row', () => {
    const db = makeDb();
    correct(db, 'STU-0001', 'absent');
    correct(db, 'STU-0001', 'present');
    const row = db.Attendance.find((a) => a.attendance_id === 'ATT-00001');
    assert.equal(row.status, 'present');
    assert.equal(row.override_status, 'present');
    const student = portal.instructorGetSession(db, { session_id: 'SES-0001' }, SESSIONS.instructorAna)
      .students.find((s) => s.student_id === 'STU-0001');
    assert.equal(student.status, 'present');
    assert.equal(student.scanned_at, '2026-11-16T08:05:00+08:00');
  });

  it('instructor session counts, roster and report (CSV source) use the effective status', () => {
    const db = makeDb();
    correct(db, 'STU-0001', 'absent');
    const { session, students } = portal.instructorGetSession(db, { session_id: 'SES-0001' }, SESSIONS.instructorAna);
    assert.deepEqual([session.present, session.late, session.absent], [0, 1, 2]);
    assert.equal(students.find((s) => s.student_id === 'STU-0001').status, 'absent');

    const roster = portal.instructorClassRoster(db, { class_id: 'CLS-0001' }, SESSIONS.instructorAna);
    assert.equal(roster.students.find((s) => s.student_id === 'STU-0001').absent, 1);

    const report = portal.instructorClassReport(db, { class_id: 'CLS-0001' }, SESSIONS.instructorAna);
    assert.deepEqual(report.students.find((s) => s.student_id === 'STU-0001').marks, ['absent']);
    assert.deepEqual([report.totals.present, report.totals.late, report.totals.absent], [0, 1, 2]);

    const dash = portal.instructorDashboard(db, { date: '2026-11-16' }, SESSIONS.instructorAna);
    assert.deepEqual([dash.sessions[0].present, dash.sessions[0].absent], [0, 2]);
  });

  it('student overview percentage and history use the effective status', () => {
    const db = makeDb();
    correct(db, 'STU-0001', 'absent');
    const overview = portal.studentOverview(db, {}, SESSIONS.student1);
    assert.equal(overview.totals.rate, 0);
    assert.equal(overview.totals.absent, 1);
    const history = portal.studentHistory(db, {}, SESSIONS.student1);
    assert.equal(history.records[0].status, 'absent');
    assert.equal(history.records[0].corrected, true);
  });

  it('admin dashboard stats and student page use the effective status', () => {
    const db = makeDb();
    const presentBefore = getAdminDashboard(db, { date: '2026-11-16' }).stats.students_present;
    correct(db, 'STU-0002', 'present'); // late -> present
    correct(db, 'STU-0001', 'absent');  // present -> absent
    const result = getAdminDashboard(db, { date: '2026-11-16' });
    const ses = result.sessions.find((s) => s.session_id === 'SES-0001');
    assert.deepEqual([ses.present, ses.late, ses.absent], [1, 0, 2]);
    assert.equal(result.stats.students_present, presentBefore - 1, 'an overridden-absent tap is not "present today"');
    assert.equal(getStudent(db, { student_id: 'STU-0002' }, SESSIONS.admin, makeCtx()).attendance.late, 0);
  });

  it('manual add for a student with no tap creates a manual row; a later change uses the override', () => {
    const db = makeDb();
    correct(db, 'STU-0003', 'late', 'reader was offline');
    const row = db.Attendance.find((a) => a.student_id === 'STU-0003');
    assert.equal(row.source, 'manual');
    assert.equal(row.status, 'late');
    assert.equal(row.created_by, SESSIONS.instructorAna.user_id);
    assert.equal(row.override_status, '');

    const count = db.Attendance.length;
    correct(db, 'STU-0003', 'absent', 'wrong student marked');
    assert.equal(db.Attendance.length, count, 'manual row is not deleted either');
    assert.equal(row.status, 'late');
    assert.equal(row.override_status, 'absent');
  });

  it('a correction on another instructor\'s class is still rejected and changes nothing', () => {
    const db = makeDb();
    const before = JSON.stringify(db.Attendance);
    assert.throws(() => portal.instructorCorrectAttendance(db, {
      session_id: 'SES-0002', student_id: 'STU-0004', status: 'absent', reason: 'Not in class',
    }, SESSIONS.instructorAna), withCode('FORBIDDEN'));
    assert.equal(JSON.stringify(db.Attendance), before);
  });
});

describe('correction reason lives in Attendance.override_reason (step 4a)', () => {
  it('a new manual row stores the reason', () => {
    const db = makeDb();
    correct(db, 'STU-0003', 'late', 'reader was offline');
    assert.equal(db.Attendance.find((a) => a.student_id === 'STU-0003').override_reason, 'reader was offline');
  });

  it('getSession and getHistory show corrections without reading AuditLog', () => {
    const db = makeDb();
    correct(db, 'STU-0003', 'late', 'reader was offline');
    correct(db, 'STU-0001', 'absent', 'card used by a friend');
    delete db.AuditLog; // any read of AuditLog would now throw
    const students = portal.instructorGetSession(db, { session_id: 'SES-0001' }, SESSIONS.instructorAna).students;
    const byId = Object.fromEntries(students.map((s) => [s.student_id, s]));
    assert.deepEqual([byId['STU-0001'].corrected, byId['STU-0001'].correction_reason], [true, 'card used by a friend']);
    assert.deepEqual([byId['STU-0003'].corrected, byId['STU-0003'].correction_reason], [true, 'reader was offline']);
    assert.deepEqual([byId['STU-0002'].corrected, byId['STU-0002'].correction_reason], [false, '']);
    assert.equal(portal.studentHistory(db, {}, SESSIONS.student1).records[0].corrected, true);
  });
});
