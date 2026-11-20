// BUG-2: admin.updateStudent with a new section moves the student's enrollments
// (drop active classes of the old section, join active classes of the new one).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, SESSIONS } from './helpers/db.js';
import { makeCtx } from './helpers/auth.js';
import { updateStudent } from '../src/handlers/students.js';
import { listAttendance } from '../src/handlers/attendance.js';

const STU1 = { student_id: 'STU-0001', student_number: '2024000001', first_name: 'Carla', last_name: 'Santos', email: '' };
const move = (db, section_id, extra = {}) => updateStudent(db, { ...STU1, section_id, ...extra }, SESSIONS.admin, makeCtx());
const rows = (db, classId) => db.Enrollments.filter((e) => e.student_id === 'STU-0001' && e.class_id === classId);
const statusIn = (db, classId) => rows(db, classId).map((e) => e.status);

// A third section with its own class; STU-0001 takes it as an irregular student.
function withIrregularClass(db) {
  db.Sections.push({ section_id: 'SEC-0003', program_id: 'PRG-0001', year_level: '3', section_name: '3C', status: 'active' });
  db.Classes.push({ class_id: 'CLS-0003', term_id: 'TRM-0001', subject_id: 'SUB-0003', section_id: 'SEC-0003', instructor_id: 'INS-0002', class_label: 'CPE303 3C', late_grace_minutes: '15', status: 'active' });
  db.Enrollments.push({ enrollment_id: 'ENR-0005', class_id: 'CLS-0003', student_id: 'STU-0001', status: 'enrolled', enrolled_at: '' });
  return db;
}

describe('BUG-2: changing a student\'s section moves their enrollments', () => {
  it('drops the old section\'s active classes and joins the new section\'s, with a summary', () => {
    const db = makeDb();
    const result = move(db, 'SEC-0002');
    assert.deepEqual(statusIn(db, 'CLS-0001'), ['dropped']);
    assert.deepEqual(statusIn(db, 'CLS-0002'), ['enrolled']);
    assert.deepEqual(result.enrollment_changes, { dropped: ['CPE301 3A'], enrolled: ['CPE302 3B'] });
  });

  it('keeps enrollments in classes of other sections (irregular students)', () => {
    const db = withIrregularClass(makeDb());
    move(db, 'SEC-0002');
    assert.deepEqual(statusIn(db, 'CLS-0003'), ['enrolled']);
  });

  it('skips a new-section class the student is already in (no duplicate, not in the summary)', () => {
    const db = makeDb();
    db.Enrollments.push({ enrollment_id: 'ENR-0005', class_id: 'CLS-0002', student_id: 'STU-0001', status: 'enrolled', enrolled_at: '' });
    const result = move(db, 'SEC-0002');
    assert.equal(rows(db, 'CLS-0002').length, 1);
    assert.deepEqual(result.enrollment_changes.enrolled, []);
  });

  it('moving back reactivates the old dropped enrollment instead of adding a duplicate', () => {
    const db = makeDb();
    move(db, 'SEC-0002');
    const result = move(db, 'SEC-0001');
    assert.deepEqual(rows(db, 'CLS-0001').map((e) => [e.enrollment_id, e.status]), [['ENR-0001', 'enrolled']]);
    assert.deepEqual(statusIn(db, 'CLS-0002'), ['dropped']);
    assert.deepEqual(result.enrollment_changes, { dropped: ['CPE302 3B'], enrolled: ['CPE301 3A'] });
  });

  it('leaves inactive classes of the old section alone', () => {
    const db = makeDb();
    db.Classes.find((c) => c.class_id === 'CLS-0001').status = 'inactive';
    const result = move(db, 'SEC-0002');
    assert.deepEqual(statusIn(db, 'CLS-0001'), ['enrolled']);
    assert.deepEqual(result.enrollment_changes.dropped, []);
  });

  it('past attendance in the old class is kept and still listed for that class', () => {
    const db = makeDb();
    const before = db.Attendance.length;
    move(db, 'SEC-0002');
    assert.equal(db.Attendance.length, before);
    const listed = listAttendance(db, { class_id: 'CLS-0001', student_id: 'STU-0001' });
    assert.deepEqual(listed.rows.map((r) => r.attendance_id), ['ATT-00001']);
  });

  it('writes ONE audit row with the enrollments before and after', () => {
    const db = withIrregularClass(makeDb());
    move(db, 'SEC-0002');
    assert.equal(db.AuditLog.length, 1);
    const audit = db.AuditLog[0];
    assert.equal(audit.action, 'STUDENT_UPDATE');
    assert.deepEqual(JSON.parse(audit.before_json).enrolled_classes, ['CLS-0001', 'CLS-0003']);
    assert.deepEqual(JSON.parse(audit.after_json).enrolled_classes, ['CLS-0002', 'CLS-0003']);
  });

  it('no section change: enrollments untouched (a manual drop stays dropped)', () => {
    const db = makeDb();
    rows(db, 'CLS-0001')[0].status = 'dropped';
    const result = move(db, 'SEC-0001', { first_name: 'Karla' });
    assert.deepEqual(statusIn(db, 'CLS-0001'), ['dropped']);
    assert.deepEqual(result.enrollment_changes, { dropped: [], enrolled: [] });
    assert.ok(!('enrolled_classes' in JSON.parse(db.AuditLog[0].after_json)));
  });

  it('a rejected update (bad email) changes nothing, enrollments included', () => {
    const db = makeDb();
    const snapshot = structuredClone(db);
    assert.throws(() => move(db, 'SEC-0002', { email: 'not-an-email' }), (e) => e.code === 'VALIDATION_ERROR');
    assert.deepEqual(db, snapshot);
  });
});
