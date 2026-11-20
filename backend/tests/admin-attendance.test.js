// admin.listAttendance / admin.getAttendanceReport, and one counting rule for
// every view: an explicit absent counts as absent at once; not_scanned is only
// for enrolled students with NO attendance row (until the session ends).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, SESSIONS, withCode, CTX, clockAt } from './helpers/db.js';
import { makeCtx } from './helpers/auth.js';
import { runAction } from '../src/actions.js';
import { startSession } from '../src/auth/session.js';
import * as portal from '../src/handlers/portal.js';
import { getAdminDashboard } from '../src/handlers/dashboard.js';
import { listAttendance, getAttendanceReport } from '../src/handlers/attendance.js';

const admin = SESSIONS.admin;
const fieldError = (field) => (error) => {
  withCode('VALIDATION_ERROR')(error);
  if (!error.fields?.[field]) throw new Error(`expected fields.${field}, got ${JSON.stringify(error.fields)}`);
  return true;
};
const ids = (result) => result.rows.map((r) => r.attendance_id);
const override = (row, status) => Object.assign(row, {
  override_status: status, override_by: 'USR-0002', override_at: '2026-11-16T09:10:00+08:00', override_reason: 'Left early',
});
const pick = (o) => ({ present: o.present, late: o.late, absent: o.absent, not_scanned: o.not_scanned });

describe('admin attendance: access', () => {
  it('non-admins are rejected for both actions', () => {
    const db = makeDb();
    const ctx = makeCtx();
    for (const userId of ['USR-0002', 'USR-0004']) {
      const { token } = startSession(db, db.Users.find((u) => u.user_id === userId), ctx);
      for (const action of ['admin.listAttendance', 'admin.getAttendanceReport']) {
        assert.throws(() => runAction(db, { action, session_token: token, group_by: 'class' }, ctx), withCode('FORBIDDEN'), action);
      }
    }
  });
});

describe('admin.listAttendance', () => {
  it('lists every row newest first with labels, total and both statuses', () => {
    const db = makeDb();
    db.Attendance[2].scanned_at = '2026-11-17T08:03:00+08:00';
    const result = listAttendance(db, {}, admin, CTX);
    assert.deepEqual(ids(result), ['ATT-00003', 'ATT-00002', 'ATT-00001']);
    assert.deepEqual([result.total, result.page, result.page_size, result.range], [3, 1, 100, { from: '', to: '' }]);
    const row = result.rows[1];
    assert.deepEqual(
      [row.session_date, row.class_label, row.room_code, row.student_number, row.student_name, row.status, row.device_status, row.source, row.sync_mode, row.corrected],
      ['2026-11-16', 'CPE301 3A', 'CPE-101', '2024000002', 'Dino Garcia', 'late', 'late', 'device', 'online', false],
    );
  });

  it('filters by class, section (of the class), student and date range', () => {
    const db = makeDb();
    assert.deepEqual(ids(listAttendance(db, { class_id: 'CLS-0002' }, admin, CTX)), ['ATT-00003']);
    assert.deepEqual(ids(listAttendance(db, { section_id: 'SEC-0001' }, admin, CTX)).sort(), ['ATT-00001', 'ATT-00002']);
    assert.deepEqual(ids(listAttendance(db, { student_id: 'STU-0002' }, admin, CTX)), ['ATT-00002']);
    const r = listAttendance(db, { from: '2026-11-16', to: '2026-11-16' }, admin, CTX);
    assert.deepEqual([ids(r).sort(), r.total, r.range], [['ATT-00001', 'ATT-00002'], 2, { from: '2026-11-16', to: '2026-11-16' }]);
  });

  it('status filter uses the effective (override) status', () => {
    const db = makeDb();
    override(db.Attendance[0], 'absent');
    const absent = listAttendance(db, { status: 'absent' }, admin, CTX);
    assert.deepEqual(ids(absent), ['ATT-00001']);
    const row = absent.rows[0];
    assert.deepEqual(
      [row.status, row.device_status, row.corrected, row.override_by, row.override_by_name, row.override_at, row.override_reason],
      ['absent', 'present', true, 'USR-0002', 'ana', '2026-11-16T09:10:00+08:00', 'Left early'],
    );
    assert.deepEqual(ids(listAttendance(db, { status: 'present' }, admin, CTX)), ['ATT-00003']);
  });

  it('pages with a total and caps page_size at 500', () => {
    const db = makeDb();
    for (let n = 4; n <= 250; n += 1) db.Attendance.push({ ...db.Attendance[0], attendance_id: `ATT-${String(n).padStart(5, '0')}` });
    const p3 = listAttendance(db, { page: 3, page_size: 100 }, admin, CTX);
    assert.deepEqual([p3.rows.length, p3.total, p3.page], [50, 250, 3]);
    assert.deepEqual([listAttendance(db, { page: 9 }, admin, CTX).rows.length, listAttendance(db, { page: 9 }, admin, CTX).total], [0, 250]);
    const big = listAttendance(db, { page_size: 9999 }, admin, CTX);
    assert.deepEqual([big.page_size, big.rows.length], [500, 250]);
  });

  it('rejects bad paging, status and dates', () => {
    const db = makeDb();
    assert.throws(() => listAttendance(db, { page: 0 }, admin, CTX), fieldError('page'));
    assert.throws(() => listAttendance(db, { page_size: 'x' }, admin, CTX), fieldError('page_size'));
    assert.throws(() => listAttendance(db, { page: 1.5 }, admin, CTX), fieldError('page'));
    assert.throws(() => listAttendance(db, { status: 'gone' }, admin, CTX), fieldError('status'));
    assert.throws(() => listAttendance(db, { status: 'not_scanned' }, admin, CTX), fieldError('status'));
    assert.throws(() => listAttendance(db, { from: '2026-02-30' }, admin, CTX), fieldError('from'));
    assert.throws(() => listAttendance(db, { from: '2026-11-17', to: '2026-11-16' }, admin, CTX), fieldError('to'));
  });

  it('manual rows and rows with missing references still list', () => {
    const db = makeDb();
    db.Attendance.push({ ...db.Attendance[0], attendance_id: 'ATT-00004', session_id: 'SES-9999', student_id: 'STU-9999', source: 'manual', sync_mode: '', device_id: '' });
    const row = listAttendance(db, { student_id: 'STU-9999' }, admin, CTX).rows[0];
    assert.deepEqual([row.source, row.sync_mode, row.class_label, row.student_name], ['manual', '', '', '']);
  });
});

describe('admin.getAttendanceReport', () => {
  it('class group matches the instructor report for the same class and range', () => {
    const db = makeDb();
    db.ClassSessions.push({ ...db.ClassSessions[0], session_id: 'SES-0003', session_date: '2026-11-09' });
    for (const range of [{}, { from: '2026-11-16', to: '2026-11-20' }, { from: '2026-11-01', to: '2026-11-10' }]) {
      const mine = portal.instructorClassReport(db, { class_id: 'CLS-0001', ...range }, SESSIONS.instructorAna, CTX);
      const group = getAttendanceReport(db, { group_by: 'class', class_id: 'CLS-0001', ...range }, admin, CTX).groups[0];
      assert.deepEqual(
        [group.key, group.present, group.late, group.absent, group.total, group.rate, group.sessions_held, group.enrolled],
        ['CLS-0001', mine.totals.present, mine.totals.late, mine.totals.absent, mine.totals.total, mine.totals.rate, mine.sessions.length, 3],
        JSON.stringify(range),
      );
    }
  });

  it('an override to absent counts as absent', () => {
    const db = makeDb();
    override(db.Attendance[0], 'absent');
    const group = getAttendanceReport(db, { group_by: 'class', class_id: 'CLS-0001' }, admin, CTX).groups[0];
    assert.deepEqual(pick(group), { present: 0, late: 1, absent: 2, not_scanned: 0 });
  });

  it('no row is not_scanned before the session ends, absent after', () => {
    const db = makeDb();
    db.ClassSessions.push({ ...db.ClassSessions[0], session_id: 'SES-0003', session_date: '2026-11-23', status: 'open' });
    const at = (iso) => getAttendanceReport(db, { group_by: 'class', class_id: 'CLS-0001', from: '2026-11-23', to: '2026-11-23' }, admin, clockAt(iso)).groups[0];
    const during = at('2026-11-23T08:30:00+08:00');
    assert.deepEqual([pick(during), during.sessions_held, during.rate], [{ present: 0, late: 0, absent: 0, not_scanned: 3 }, 1, null]);
    assert.deepEqual(pick(at('2026-11-23T10:01:00+08:00')), { present: 0, late: 0, absent: 3, not_scanned: 0 });
    assert.equal(at('2026-11-23T07:00:00+08:00').sessions_held, 0);
  });

  it('cancelled sessions and dropped students do not count', () => {
    const db = makeDb();
    db.ClassSessions[0].status = 'cancelled';
    db.Enrollments[3].status = 'dropped';
    const groups = getAttendanceReport(db, { group_by: 'class' }, admin, CTX).groups;
    assert.deepEqual(groups.map((g) => [g.key, g.sessions_held, g.enrolled, g.total]), [['CLS-0001', 0, 3, 0], ['CLS-0002', 1, 0, 0]]);
  });

  it('groups by section (of the class) and filters by section', () => {
    const db = makeDb();
    const all = getAttendanceReport(db, { group_by: 'section' }, admin, CTX);
    assert.deepEqual(all.groups.map((g) => [g.key, g.label, g.present, g.late, g.absent]), [
      ['SEC-0001', 'BSCpE 3A', 1, 1, 1],
      ['SEC-0002', 'BSCpE 3B', 1, 0, 0],
    ]);
    assert.deepEqual(pick(all.totals), { present: 2, late: 1, absent: 1, not_scanned: 0 });
    const one = getAttendanceReport(db, { group_by: 'section', section_id: 'SEC-0002' }, admin, CTX);
    assert.deepEqual(one.groups.map((g) => g.key), ['SEC-0002']);
  });

  it('groups by student', () => {
    const db = makeDb();
    const groups = getAttendanceReport(db, { group_by: 'student' }, admin, CTX).groups;
    assert.deepEqual(groups.map((g) => [g.key, g.enrolled, g.sessions_held, g.present, g.late, g.absent, g.rate]).sort(), [
      ['STU-0001', 1, 1, 1, 0, 0, 1],
      ['STU-0002', 1, 1, 0, 1, 0, 1],
      ['STU-0003', 1, 1, 0, 0, 1, 0],
      ['STU-0004', 1, 1, 1, 0, 0, 1],
    ]);
  });

  it('shows queued offline scans per device', () => {
    const db = makeDb();
    db.Settings.push({ key: 'device_offline_after_minutes', value: '10' });
    db.Rooms[0].room_code = 'CPE-101';
    db.Devices.push(
      { device_id: 'DEV-CPE101-01', device_name: 'Lab 1 reader', room_id: 'RM-0001', status: 'active', queue_count: '4', last_seen_at: '2026-11-20T11:55:00+08:00', battery_voltage: '3.9' },
      { device_id: 'DEV-CPE101-02', device_name: 'Old', room_id: '', status: 'retired', queue_count: '7', last_seen_at: '', battery_voltage: '' },
    );
    const report = getAttendanceReport(db, { group_by: 'class' }, admin, CTX);
    assert.deepEqual(report.devices, [{
      device_id: 'DEV-CPE101-01', device_name: 'Lab 1 reader', room_code: 'CPE-101', status: 'active',
      queue_count: 4, last_seen_at: '2026-11-20T11:55:00+08:00', online: true,
    }]);
    assert.equal(report.pending_offline_scans, 4);
    assert.equal(JSON.stringify(report).includes('device_key'), false);
  });

  it('rejects a bad group_by and a bad range', () => {
    const db = makeDb();
    assert.throws(() => getAttendanceReport(db, { group_by: 'room' }, admin, CTX), fieldError('group_by'));
    assert.throws(() => getAttendanceReport(db, {}, admin, CTX), fieldError('group_by'));
    assert.throws(() => getAttendanceReport(db, { group_by: 'class', from: '2026-11-17', to: '2026-11-16' }, admin, CTX), fieldError('to'));
    assert.throws(() => getAttendanceReport(db, { group_by: 'class', to: 'x' }, admin, CTX), fieldError('to'));
  });
});

describe('one counting rule for every view', () => {
  // SES-0001 running (09:00): STU-0001 present, STU-0002 overridden late -> absent, STU-0003 no row.
  const DURING = clockAt('2026-11-16T09:00:00+08:00');
  const EXPECTED = { present: 1, late: 0, absent: 1, not_scanned: 1 };
  const setup = () => {
    const db = makeDb();
    db.ClassSessions[0].status = 'open';
    override(db.Attendance[1], 'absent');
    return db;
  };

  it('instructor session view, dashboards, instructor report, student overview and admin report agree', () => {
    const db = setup();
    const ana = SESSIONS.instructorAna;
    assert.deepEqual(pick(portal.instructorGetSession(db, { session_id: 'SES-0001' }, ana, DURING).session), EXPECTED, 'getSession');
    assert.deepEqual(pick(portal.instructorDashboard(db, { date: '2026-11-16' }, ana, DURING).sessions[0]), EXPECTED, 'instructor dashboard');
    assert.deepEqual(pick(getAdminDashboard(db, { date: '2026-11-16' }, admin, DURING).sessions[0]), EXPECTED, 'admin dashboard');

    const report = portal.instructorClassReport(db, { class_id: 'CLS-0001' }, ana, DURING);
    const marks = report.students.flatMap((s) => s.marks);
    assert.deepEqual({ ...pick(report.totals), not_scanned: marks.filter((m) => m === 'not_scanned').length }, EXPECTED, 'instructor report');

    const statuses = ['STU-0001', 'STU-0002', 'STU-0003'].map((studentId, n) => {
      db.Users.push({ ...db.Users[3], user_id: `USR-01${n}`, linked_id: studentId });
      return portal.studentOverview(db, {}, { user_id: `USR-01${n}`, role: 'student' }, DURING).recent[0].status;
    });
    assert.deepEqual(statuses, ['present', 'absent', 'not_scanned'], 'student overview');

    assert.deepEqual(pick(getAttendanceReport(db, { group_by: 'class', class_id: 'CLS-0001' }, admin, DURING).groups[0]), EXPECTED, 'admin report');
  });
});
