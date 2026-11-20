// Inactive (past) classes: instructors can still read them, in a separate
// past_classes list, but never correct them (CLASS_INACTIVE).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, SESSIONS, withCode, CTX } from './helpers/db.js';
import * as portal from '../src/handlers/portal.js';

function dbWithPastClasses() {
  const db = makeDb();
  db.Classes.push(
    { ...db.Classes[0], class_id: 'CLS-0003', class_label: 'CPE303 3A', subject_id: 'SUB-0003', status: 'inactive' },
    { ...db.Classes[1], class_id: 'CLS-0004', class_label: 'CPE303 3B', subject_id: 'SUB-0003', status: 'inactive' }, // Ben's
  );
  db.Classes[0].status = 'active';
  return db;
}

const ids = (rows) => rows.map((row) => row.class_id);

describe('past / inactive classes for instructors', () => {
  it('dashboard, listSessions and getClassReport list only OWN inactive classes in past_classes', () => {
    const db = dbWithPastClasses();
    const ana = SESSIONS.instructorAna;
    const dashboard = portal.instructorDashboard(db, { date: '2026-11-16' }, ana, CTX);
    const sessions = portal.instructorListSessions(db, {}, ana, CTX);
    const report = portal.instructorClassReport(db, {}, ana, CTX);
    [dashboard, sessions, report].forEach((result) => {
      assert.deepEqual(ids(result.classes), ['CLS-0001']);
      assert.deepEqual(ids(result.past_classes), ['CLS-0003']);
    });
    assert.equal(dashboard.past_classes[0].class_label, 'CPE303 3A');
    assert.equal(dashboard.past_classes[0].term_name, '1st Sem');
  });

  it('class objects carry status so the page can be read-only', () => {
    const db = dbWithPastClasses();
    const ana = SESSIONS.instructorAna;
    assert.equal(portal.instructorListSessions(db, { class_id: 'CLS-0003' }, ana, CTX).class.status, 'inactive');
    assert.equal(portal.instructorListSessions(db, { class_id: 'CLS-0001' }, ana, CTX).class.status, 'active');
    db.ClassSessions.push({ ...db.ClassSessions[0], session_id: 'SES-0009', class_id: 'CLS-0003' });
    assert.equal(portal.instructorGetSession(db, { session_id: 'SES-0009' }, ana, CTX).class.status, 'inactive');
  });

  it('still refuses corrections on an inactive class and another instructor\'s past class', () => {
    const db = dbWithPastClasses();
    const ana = SESSIONS.instructorAna;
    db.ClassSessions.push({ ...db.ClassSessions[0], session_id: 'SES-0009', class_id: 'CLS-0003' });
    db.Enrollments.push({ enrollment_id: 'ENR-0009', class_id: 'CLS-0003', student_id: 'STU-0001', status: 'enrolled', enrolled_at: '' });
    assert.throws(() => portal.instructorCorrectAttendance(db, {
      session_id: 'SES-0009', student_id: 'STU-0001', status: 'present', reason: 'Was in class',
    }, ana, CTX), withCode('CLASS_INACTIVE'));
    assert.throws(() => portal.instructorListSessions(db, { class_id: 'CLS-0004' }, ana, CTX), withCode('FORBIDDEN'));
  });
});
