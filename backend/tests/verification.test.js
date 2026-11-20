// Backend verification (docs/BACKEND_VERIFICATION.md).
// Part A: behaviour we checked and rely on (must pass).
// Part B: confirmed bugs, written as the CORRECT behaviour and marked `todo`.
//         They run and fail today; node:test reports them as TODO so the suite
//         stays green. When a bug is fixed, remove its `todo` option.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, SESSIONS, CTX, clockAt } from './helpers/db.js';
import { makeCtx } from './helpers/auth.js';
import { ACTIONS, READ } from '../src/actions.js';
import { manilaAt, writeAudit, nextId } from '../src/utils.js';
import * as portal from '../src/handlers/portal.js';
import * as classes from '../src/handlers/classes.js';
import { updateStudent } from '../src/handlers/students.js';
import { getAdminDashboard } from '../src/handlers/dashboard.js';

/* ======================= Part A: verified behaviour ======================= */

// Server.gs saves nothing after a READ action, so a READ handler that changed
// the db would lose that change silently. Every READ action must leave it as is.
const READ_CALLS = {
  'auth.me': [SESSIONS.instructorAna, {}],
  'admin.getDashboard': [SESSIONS.admin, { date: '2026-11-16' }],
  'admin.getStudentOptions': [SESSIONS.admin, {}],
  'admin.listStudents': [SESSIONS.admin, {}],
  'admin.getStudent': [SESSIONS.admin, { student_id: 'STU-0001' }],
  'admin.listUnregisteredUids': [SESSIONS.admin, {}],
  'admin.listTerms': [SESSIONS.admin, {}],
  'admin.listPrograms': [SESSIONS.admin, {}],
  'admin.listSections': [SESSIONS.admin, {}],
  'admin.listSubjects': [SESSIONS.admin, {}],
  'admin.listRooms': [SESSIONS.admin, {}],
  'admin.listDevices': [SESSIONS.admin, {}],
  'admin.listInstructors': [SESSIONS.admin, {}],
  'admin.listAdmins': [SESSIONS.admin, {}],
  'admin.getSettings': [SESSIONS.admin, {}],
  'admin.getClassOptions': [SESSIONS.admin, {}],
  'admin.listClasses': [SESSIONS.admin, {}],
  'admin.getClass': [SESSIONS.admin, { class_id: 'CLS-0001' }],
  'admin.listAttendance': [SESSIONS.admin, {}],
  'admin.getAttendanceReport': [SESSIONS.admin, { group_by: 'student' }],
  'instructor.getDashboard': [SESSIONS.instructorAna, { date: '2026-11-16' }],
  'instructor.listSessions': [SESSIONS.instructorAna, { class_id: 'CLS-0001' }],
  'instructor.getSession': [SESSIONS.instructorAna, { session_id: 'SES-0001' }],
  'instructor.getClassReport': [SESSIONS.instructorAna, { class_id: 'CLS-0001' }],
  'instructor.getClassRoster': [SESSIONS.instructorAna, { class_id: 'CLS-0001' }],
  'instructor.getStudentHistory': [SESSIONS.instructorAna, { class_id: 'CLS-0001', student_id: 'STU-0001' }],
  'student.getOverview': [SESSIONS.student1, {}],
  'student.getHistory': [SESSIONS.student1, {}],
  'student.getProfile': [SESSIONS.student1, {}],
};

describe('verified: read actions', () => {
  it('every READ action is covered by this check', () => {
    const reads = Object.entries(ACTIONS).filter(([, a]) => a.mode === READ).map(([name]) => name).sort();
    assert.deepEqual(reads, Object.keys(READ_CALLS).sort());
  });

  it('no READ action changes the db (Server.gs would not save it)', () => {
    for (const [name, [session, params]] of Object.entries(READ_CALLS)) {
      const db = makeDb();
      const before = JSON.stringify(db);
      ACTIONS[name].run(db, params, session, makeCtx());
      assert.equal(JSON.stringify(db), before, name);
    }
  });
});

describe('verified: Asia/Manila day boundary', () => {
  it('23:59:59 and 00:00:00 Manila fall on different dates (server clock in UTC)', () => {
    assert.equal(manilaAt(Date.UTC(2026, 10, 18, 15, 59, 59)).iso, '2026-11-18T23:59:59+08:00');
    const next = manilaAt(Date.UTC(2026, 10, 18, 16, 0, 0));
    assert.deepEqual([next.date, next.time], ['2026-11-19', '00:00']);
  });

  it('the admin dashboard "today" follows Manila time, not UTC', () => {
    const ctx = { now: () => Date.UTC(2026, 10, 16, 16, 30, 0) }; // Tue 00:30 Manila
    assert.equal(getAdminDashboard(makeDb(), { date: '2026-11-17' }, null, ctx).today, '2026-11-17');
  });
});

/* ===================== Part B: confirmed bugs (todo) ===================== */

describe('known bugs (todo until fixed)', () => {
  it('BUG-1 correcting a device record to "absent" keeps the scan evidence', () => {
    const db = makeDb();
    const row = db.Attendance.find((a) => a.attendance_id === 'ATT-00001');
    portal.instructorCorrectAttendance(db, { session_id: 'SES-0001', student_id: 'STU-0001', status: 'absent', reason: 'card used by a friend' }, SESSIONS.instructorAna, CTX);
    const kept = db.Attendance.includes(row) || db.AuditLog.at(-1).before_json.includes(row.scanned_at);
    assert.ok(kept, 'scanned_at / scan_id / device_id of the tap are gone');
  });

  it('BUG-2 moving a student to another section updates their class enrollments', { todo: 'BUG-2: students.js updateStudent never calls enrollInSectionClasses' }, () => {
    const db = makeDb();
    updateStudent(db, { student_id: 'STU-0001', student_number: '2024000001', first_name: 'Carla', last_name: 'Santos', section_id: 'SEC-0002', email: '' }, SESSIONS.admin, makeCtx());
    const enrolled = db.Enrollments.filter((e) => e.student_id === 'STU-0001' && e.status === 'enrolled').map((e) => e.class_id);
    assert.ok(enrolled.includes('CLS-0002'), `still enrolled only in ${enrolled.join(', ')} (old section)`);
  });

  it('BUG-3 re-activating a class cannot double-book a room', () => {
    const db = makeDb();
    classes.setClassStatus(db, { class_id: 'CLS-0001', status: 'inactive' }, SESSIONS.admin, CTX);
    db.Subjects.push({ subject_id: 'SUB-0004', subject_code: 'CPE304', subject_title: 'Robotics', units: '3', status: 'active' });
    const { class_id: newClass } = classes.createClass(db, { term_id: 'TRM-0001', subject_id: 'SUB-0004', section_id: 'SEC-0002', instructor_id: 'INS-0002' }, SESSIONS.admin, CTX);
    classes.addSchedule(db, { class_id: newClass, day_of_week: 'MON', start_time: '08:00', end_time: '10:00', room_id: 'RM-0001' }, SESSIONS.admin, CTX);
    assert.throws(() => classes.setClassStatus(db, { class_id: 'CLS-0001', status: 'active' }, SESSIONS.admin, CTX),
      (error) => error.code === 'VALIDATION_ERROR' && /CPE-101 is already used by CPE304/.test(error.message),
      'CLS-0001 and the new class now both own RM-0001 on MON 08:00-10:00');
  });

  it('BUG-4 admin dashboard attendance rate never exceeds 100%', () => {
    const db = makeDb();
    db.Attendance.push({ ...db.Attendance[0], attendance_id: 'ATT-00009', student_id: 'STU-0003' });
    classes.dropEnrollment(db, { class_id: 'CLS-0001', student_id: 'STU-0003', reason: 'shifted' }, SESSIONS.admin, CTX);
    const rate = getAdminDashboard(db, { date: '2026-11-16' }, null, CTX).stats.attendance_rate;
    assert.ok(rate <= 1, `rate is ${rate}`);
  });

  it('BUG-5 writeAudit works with a large AuditLog', () => {
    const db = makeDb();
    db.AuditLog = Array.from({ length: 200000 }, (_, i) => ({ audit_id: `AUD-${String(i + 1).padStart(4, '0')}` }));
    writeAudit(db, SESSIONS.admin, { action: 'X', entityType: 'X', entityId: 'X' }, CTX);
    assert.equal(db.AuditLog.at(-1).audit_id, 'AUD-200001');
  });

  it('BUG-5 nextId works with a large table (Attendance)', () => {
    const rows = Array.from({ length: 200000 }, (_, i) => ({ attendance_id: `ATT-${String(i + 1).padStart(5, '0')}` }));
    assert.equal(nextId(rows, 'attendance_id', 'ATT', 5), 'ATT-200001');
  });

  it('BUG-6 "absent" correction during an open session is refused, not a silent no-op', { todo: 'BUG-6: portal.js:350-354 writes an audit row but nothing changes' }, () => {
    const db = makeDb();
    db.ClassSessions[0].status = 'open';
    assert.throws(() => portal.instructorCorrectAttendance(db, { session_id: 'SES-0001', student_id: 'STU-0003', status: 'absent', reason: 'did not attend' }, SESSIONS.instructorAna, CTX));
  });

  it('BUG-7 a running session does not count not-yet-scanned students as absent', () => {
    const db = makeDb();
    db.ClassSessions[0].status = 'open';
    const during = portal.instructorGetSession(db, { session_id: 'SES-0001' }, SESSIONS.instructorAna, clockAt('2026-11-16T09:00:00+08:00'));
    assert.equal(during.students.filter((s) => s.status === 'not_scanned').length, 1);
    assert.deepEqual([during.session.absent, during.session.not_scanned], [0, 1]);
    const after = portal.instructorGetSession(db, { session_id: 'SES-0001' }, SESSIONS.instructorAna, clockAt('2026-11-16T10:01:00+08:00'));
    assert.equal(after.students.filter((s) => s.status === 'absent').length, 1);
    assert.deepEqual([after.session.absent, after.session.not_scanned], [1, 0]);
  });

  it('BUG-8 a correction never edits a device-created row in place (architecture 7.2.4)', () => {
    const db = makeDb();
    const row = db.Attendance.find((a) => a.attendance_id === 'ATT-00001');
    portal.instructorCorrectAttendance(db, { session_id: 'SES-0001', student_id: 'STU-0001', status: 'late', reason: 'came in late' }, SESSIONS.instructorAna, CTX);
    assert.equal(row.status, 'present', 'device row was rewritten (source still "device", status now "late")');
  });
});
