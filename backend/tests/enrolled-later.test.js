// A student enrolled after a session ended was never expected there: with no
// attendance row they count as nothing for that session (not absent, not "not yet").
// Found in the Batch 8 E2E test: a new student auto-enrolled into section classes
// showed "Absent 9" for sessions held before they existed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, SESSIONS, CTX } from './helpers/db.js';
import { getAdminDashboard } from '../src/handlers/dashboard.js';
import { getAttendanceReport } from '../src/handlers/attendance.js';
import * as portal from '../src/handlers/portal.js';

// SES-0001: CLS-0001, 2026-11-16 08:00-10:00, closed. STU-0003 has no row there.
const enrolledAt = (iso) => {
  const db = makeDb();
  db.Enrollments.find((e) => e.student_id === 'STU-0003').enrolled_at = iso;
  return db;
};
const AFTER = '2026-11-16T10:30:00+08:00';
const DURING = '2026-11-16T09:00:00+08:00';
const ana = SESSIONS.instructorAna;

describe('enrolled after the session ended', () => {
  it('is not counted in the session (dashboard, instructor session, report)', () => {
    const db = enrolledAt(AFTER);
    const row = getAdminDashboard(db, { date: '2026-11-16' }, SESSIONS.admin, CTX).sessions[0];
    assert.deepEqual([row.enrolled, row.present, row.late, row.absent, row.not_scanned], [2, 1, 1, 0, 0]);

    const s = portal.instructorGetSession(db, { session_id: 'SES-0001' }, ana, CTX);
    assert.ok(!s.students.some((x) => x.student_id === 'STU-0003'), 'not on that session roster');
    assert.equal(s.session.absent, 0);

    const report = getAttendanceReport(db, { group_by: 'student' }, SESSIONS.admin, CTX);
    const g = report.groups.find((x) => x.key === 'STU-0003');
    assert.deepEqual([g.present, g.late, g.absent, g.total], [0, 0, 0, 0]);
  });

  it('class report marks it as null and leaves it out of the totals; history skips it', () => {
    const db = enrolledAt(AFTER);
    const report = portal.instructorClassReport(db, { class_id: 'CLS-0001' }, ana, CTX);
    const stu = report.students.find((x) => x.student_id === 'STU-0003');
    assert.deepEqual(stu.marks, [null]);
    assert.deepEqual([stu.absent, stu.total], [0, 0]);
    assert.equal(report.totals.absent, 0);

    const roster = portal.instructorClassRoster(db, { class_id: 'CLS-0001' }, ana, CTX);
    assert.equal(roster.students.find((x) => x.student_id === 'STU-0003').absent, 0);

    const history = portal.instructorStudentHistory(db, { class_id: 'CLS-0001', student_id: 'STU-0003' }, ana, CTX);
    assert.deepEqual(history.records, []);
    assert.equal(history.totals.absent, 0);
  });

  it('enrolled during (or before) the session: still absent without a tap', () => {
    for (const iso of [DURING, '']) {
      const db = enrolledAt(iso);
      const row = getAdminDashboard(db, { date: '2026-11-16' }, SESSIONS.admin, CTX).sessions[0];
      assert.deepEqual([row.enrolled, row.absent], [3, 1], `enrolled_at "${iso}"`);
    }
  });

  it('a row always counts, even if the enrollment date is later', () => {
    const db = enrolledAt(AFTER);
    db.Enrollments.find((e) => e.student_id === 'STU-0002').enrolled_at = AFTER; // STU-0002 has a late row
    const row = getAdminDashboard(db, { date: '2026-11-16' }, SESSIONS.admin, CTX).sessions[0];
    assert.deepEqual([row.enrolled, row.present, row.late, row.absent], [2, 1, 1, 0]);
  });
});
