// Schedule overlap rules and enrollment uniqueness.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, SESSIONS, withCode } from './helpers/db.js';
import { addSchedule, enrollStudents, dropEnrollment } from '../src/handlers/classes.js';

// A third class with no schedule yet. CLS-0001 meets MON 08:00-10:00 in RM-0001
// (instructor INS-0001, section SEC-0001).
function dbWithNewClass({ instructor = 'INS-0002', section = 'SEC-0002' } = {}) {
  const db = makeDb();
  db.Classes.push({
    class_id: 'CLS-0003', term_id: 'TRM-0001', subject_id: 'SUB-0003', section_id: section,
    instructor_id: instructor, class_label: 'CPE303', late_grace_minutes: '15', status: 'active',
  });
  return db;
}

const slot = (fields) => ({ class_id: 'CLS-0003', day_of_week: 'MON', start_time: '09:00', end_time: '11:00', room_id: 'RM-0002', ...fields });

function clashMessage(db, input) {
  try {
    addSchedule(db, input, SESSIONS.admin);
  } catch (error) {
    withCode('VALIDATION_ERROR')(error);
    return error.fields.start_time;
  }
  assert.fail('expected the schedule to be rejected');
}

describe('schedule overlap is rejected', () => {
  it('rejects the same room at an overlapping time', () => {
    const db = dbWithNewClass();
    assert.match(clashMessage(db, slot({ room_id: 'RM-0001' })), /CPE-101 is already used by CPE301 3A/);
    assert.equal(db.Schedules.length, 2);
  });

  it('rejects the same instructor at an overlapping time (different room)', () => {
    const db = dbWithNewClass({ instructor: 'INS-0001' });
    assert.match(clashMessage(db, slot()), /Ana Reyes already teaches CPE301 3A/);
  });

  it('rejects the same section at an overlapping time (different room and instructor)', () => {
    const db = dbWithNewClass({ section: 'SEC-0001' });
    assert.match(clashMessage(db, slot()), /This section already has CPE301 3A/);
  });

  it('rejects a second slot of the same class that overlaps its own schedule', () => {
    const db = makeDb();
    assert.match(clashMessage(db, slot({ class_id: 'CLS-0001' })), /already meets on MON 08:00/);
  });

  it('accepts a back-to-back slot (10:00 start right after a 10:00 end)', () => {
    const db = dbWithNewClass({ instructor: 'INS-0001', section: 'SEC-0001' });
    const result = addSchedule(db, slot({ room_id: 'RM-0001', start_time: '10:00', end_time: '11:00' }), SESSIONS.admin);
    assert.equal(result.schedule_id, 'SCH-0003');
    assert.equal(db.Schedules.length, 3);
  });

  it('ignores schedules of inactive classes', () => {
    const db = dbWithNewClass();
    db.Classes[0].status = 'inactive';
    addSchedule(db, slot({ room_id: 'RM-0001' }), SESSIONS.admin);
    assert.equal(db.Schedules.length, 3);
  });

  it('rejects an end time that is not after the start time', () => {
    const db = dbWithNewClass();
    assert.throws(() => addSchedule(db, slot({ start_time: '11:00', end_time: '11:00' }), SESSIONS.admin), (error) =>
      withCode('VALIDATION_ERROR')(error) && error.fields.end_time === 'End time must be after the start time.');
  });
});

describe('enrollment is unique per class and student', () => {
  const rowsFor = (db, classId, studentId) => db.Enrollments.filter((e) => e.class_id === classId && e.student_id === studentId);

  it('enrolling an already-enrolled student adds nothing', () => {
    const db = makeDb();
    const result = enrollStudents(db, { class_id: 'CLS-0001', student_ids: ['STU-0001'] }, SESSIONS.admin);
    assert.equal(result.added, 0);
    assert.equal(rowsFor(db, 'CLS-0001', 'STU-0001').length, 1);
    assert.equal(db.AuditLog.length, 0);
  });

  it('the same student twice in one request creates one row', () => {
    const db = makeDb();
    const result = enrollStudents(db, { class_id: 'CLS-0001', student_ids: ['STU-0004', 'STU-0004'] }, SESSIONS.admin);
    assert.equal(result.added, 1);
    assert.equal(rowsFor(db, 'CLS-0001', 'STU-0004').length, 1);
  });

  it('re-enrolling after a drop reuses the same row', () => {
    const db = makeDb();
    dropEnrollment(db, { class_id: 'CLS-0001', student_id: 'STU-0002', reason: 'Changed section' }, SESSIONS.admin);
    assert.equal(rowsFor(db, 'CLS-0001', 'STU-0002')[0].status, 'dropped');
    enrollStudents(db, { class_id: 'CLS-0001', student_ids: 'STU-0002' }, SESSIONS.admin);
    const rows = rowsFor(db, 'CLS-0001', 'STU-0002');
    assert.deepEqual(rows.map((r) => [r.enrollment_id, r.status]), [['ENR-0002', 'enrolled']]);
  });

  it('refuses inactive students', () => {
    const db = makeDb();
    db.Students[3].account_status = 'inactive';
    assert.throws(() => enrollStudents(db, { class_id: 'CLS-0001', student_ids: ['STU-0004'] }, SESSIONS.admin), withCode('VALIDATION_ERROR'));
    assert.equal(rowsFor(db, 'CLS-0001', 'STU-0004').length, 0);
  });
});
