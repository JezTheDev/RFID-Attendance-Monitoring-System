// Session engine (step 4c): which class session a tap belongs to. Fake clock, Asia/Manila.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers/db.js';
import { resolveScan, sessionPhase, missingStatus } from '../src/sessions.js';
import { manilaAt } from '../src/utils.js';

const SETTINGS = { early_window_minutes: '15', accept_after_end_minutes: '0' };
// Monday 2026-11-23; CLS-0001 (STU-0001..3) meets MON 08:00-10:00 in RM-0001.
const at = (hm, date = '2026-11-23') => Date.parse(`${date}T${hm}+08:00`) / 1000;

function scan(db, hm, studentId = 'STU-0001', { date, nowMs, room = 'RM-0001' } = {}) {
  const scannedAt = at(hm.length === 5 ? `${hm}:00` : hm, date);
  return resolveScan(db, { room_id: room, scanned_at: scannedAt, student_id: studentId }, SETTINGS, nowMs ?? scannedAt * 1000 + 60000);
}

function addClass(db, classId, scheduleId, day, start, end, students) {
  db.Classes.push({ ...db.Classes[0], class_id: classId, class_label: classId });
  db.Schedules.push({ schedule_id: scheduleId, class_id: classId, room_id: 'RM-0001', day_of_week: day, start_time: start, end_time: end, status: 'active' });
  students.forEach((id, i) => db.Enrollments.push({ enrollment_id: `ENR-9${classId.slice(-1)}${i}`, class_id: classId, student_id: id, status: 'enrolled', enrolled_at: '' }));
}

function addSession(db, fields) {
  const row = {
    session_id: `SES-00${10 + db.ClassSessions.length}`, class_id: 'CLS-0001', room_id: 'RM-0001', schedule_id: 'SCH-0001',
    session_date: '2026-11-23', scheduled_start: '08:00', scheduled_end: '10:00', actual_start: '', actual_end: '',
    source: 'auto', status: 'open', opened_by: '', closed_by: '', override_reason: '', created_at: '', ...fields,
  };
  db.ClassSessions.push(row);
  return row;
}

const record = (db, sessionId, studentId) => db.Attendance.push({ attendance_id: `ATT-9${db.Attendance.length}`, session_id: sessionId, student_id: studentId, status: 'present' });

describe('resolveScan: tap window', () => {
  it('accepts a tap 15 minutes early and creates the session lazily', () => {
    const db = makeDb();
    const r = scan(db, '07:45');
    assert.equal(r.result, 'ACCEPTED');
    assert.equal(r.attendance_status, 'present');
    assert.equal(r.class_id, 'CLS-0001');
    assert.equal(r.session, undefined);
    assert.deepEqual(
      [r.newSession.session_id, r.newSession.schedule_id, r.newSession.session_date, r.newSession.scheduled_start, r.newSession.scheduled_end, r.newSession.source, r.newSession.status, r.newSession.room_id],
      ['SES-0003', 'SCH-0001', '2026-11-23', '08:00', '10:00', 'auto', 'open', 'RM-0001'],
    );
    assert.match(r.newSession.created_at, /^2026-11-23T07:46:00\+08:00$/);
  });

  it('rejects a tap 16 minutes early', () => assert.equal(scan(makeDb(), '07:44').result, 'NO_ACTIVE_SESSION'));
  it('accepts a tap at the exact end (same minute)', () => {
    assert.equal(scan(makeDb(), '10:00').result, 'ACCEPTED');
    assert.equal(scan(makeDb(), '10:00:59').result, 'ACCEPTED');
  });
  it('rejects a tap 1 minute after the end', () => assert.equal(scan(makeDb(), '10:01').result, 'NO_ACTIVE_SESSION'));
  it('ignores a schedule on another day', () => assert.equal(scan(makeDb(), '08:30', 'STU-0001', { date: '2026-11-24' }).result, 'NO_ACTIVE_SESSION'));
  it('ignores another room', () => assert.equal(scan(makeDb(), '08:30', 'STU-0001', { room: 'RM-0002' }).result, 'NO_ACTIVE_SESSION'));
});

describe('resolveScan: active data only', () => {
  it('ignores an inactive class', () => {
    const db = makeDb();
    db.Classes[0].status = 'inactive';
    assert.equal(scan(db, '08:30').result, 'NO_ACTIVE_SESSION');
  });
  it('ignores an inactive schedule', () => {
    const db = makeDb();
    db.Schedules[0].status = 'inactive';
    assert.equal(scan(db, '08:30').result, 'NO_ACTIVE_SESSION');
  });
  it('ignores an inactive term', () => {
    const db = makeDb();
    db.Terms[0].is_active = 'FALSE';
    assert.equal(scan(db, '08:30').result, 'NO_ACTIVE_SESSION');
  });
  it('ignores a date outside the term', () => assert.equal(scan(makeDb(), '08:30', 'STU-0001', { date: '2026-12-21' }).result, 'NO_ACTIVE_SESSION'));
  it('ignores a class of another term', () => {
    const db = makeDb();
    db.Classes[0].term_id = 'TRM-0000';
    assert.equal(scan(db, '08:30').result, 'NO_ACTIVE_SESSION');
  });
});

describe('resolveScan: time checks', () => {
  it('rejects missing, zero and non-numeric scanned_at', () => {
    const db = makeDb();
    [undefined, 0, '', 'abc', null].forEach((value) => {
      assert.equal(resolveScan(db, { room_id: 'RM-0001', scanned_at: value, student_id: 'STU-0001' }, SETTINGS, Date.now()).result, 'INVALID_TIME');
    });
  });
  it('rejects a time more than 5 minutes ahead of the server, allows up to 5', () => {
    const now = at('08:30:00') * 1000;
    assert.equal(scan(makeDb(), '08:35:01', 'STU-0001', { nowMs: now }).result, 'INVALID_TIME');
    assert.equal(scan(makeDb(), '08:35:00', 'STU-0001', { nowMs: now }).result, 'ACCEPTED');
  });
  it('uses the Manila date: 11:59 PM Sunday vs 12:00 AM Monday', () => {
    const db = makeDb();
    addClass(db, 'CLS-0007', 'SCH-0007', 'SUN', '23:00', '23:59', ['STU-0001']);
    addClass(db, 'CLS-0008', 'SCH-0008', 'MON', '00:00', '01:00', ['STU-0001']);
    const late = scan(db, '23:59:30', 'STU-0001', { date: '2026-11-22' });
    assert.deepEqual([late.class_id, late.newSession.session_date], ['CLS-0007', '2026-11-22']);
    const early = scan(db, '00:00:00', 'STU-0001', { date: '2026-11-23' });
    assert.deepEqual([early.class_id, early.newSession.session_date], ['CLS-0008', '2026-11-23']);
  });
});

describe('resolveScan: sessions', () => {
  it('second tap reuses the session the first tap created', () => {
    const db = makeDb();
    const first = scan(db, '07:50', 'STU-0001');
    db.ClassSessions.push(first.newSession);
    record(db, first.newSession.session_id, 'STU-0001');
    const second = scan(db, '07:55', 'STU-0002');
    assert.equal(second.result, 'ACCEPTED');
    assert.equal(second.newSession, undefined);
    assert.equal(second.session, first.newSession);
  });
  it('DUPLICATE when the student already has a record', () => {
    const db = makeDb();
    const s = addSession(db, {});
    record(db, s.session_id, 'STU-0001');
    const r = scan(db, '08:30', 'STU-0001');
    assert.deepEqual([r.result, r.session], ['DUPLICATE', s]);
  });
  it('NOT_ENROLLED for a student outside the class', () => {
    const r = scan(makeDb(), '08:30', 'STU-0004');
    assert.deepEqual([r.result, r.class_id], ['NOT_ENROLLED', 'CLS-0001']);
  });
  it('SESSION_CANCELLED for a cancelled session of the slot', () => {
    const db = makeDb();
    addSession(db, { status: 'cancelled' });
    assert.equal(scan(db, '08:30').result, 'SESSION_CANCELLED');
  });
  it('a manual session in the room wins over the schedule', () => {
    const db = makeDb();
    const manual = addSession(db, { class_id: 'CLS-0002', schedule_id: '', source: 'manual', scheduled_start: '08:30', scheduled_end: '09:30' });
    const r = scan(db, '09:00', 'STU-0004');
    assert.deepEqual([r.result, r.class_id, r.session], ['ACCEPTED', 'CLS-0002', manual]);
    assert.equal(scan(db, '09:00', 'STU-0001').result, 'NOT_ENROLLED');
  });
});

describe('resolveScan: back-to-back classes in one room', () => {
  // CLS-0003 meets MON 10:00-12:00 in RM-0001; a 09:50 tap fits both classes.
  it('picks the class the student is enrolled in', () => {
    const db = makeDb();
    addClass(db, 'CLS-0003', 'SCH-0003', 'MON', '10:00', '12:00', ['STU-0004']);
    assert.equal(scan(db, '09:50', 'STU-0004').class_id, 'CLS-0003');
    assert.equal(scan(db, '09:50', 'STU-0001').class_id, 'CLS-0001');
  });
  it('enrolled in both: picks the one without a record', () => {
    const db = makeDb();
    addClass(db, 'CLS-0003', 'SCH-0003', 'MON', '10:00', '12:00', ['STU-0001']);
    assert.equal(scan(db, '09:50', 'STU-0001').class_id, 'CLS-0001', 'no records: the class in progress');
    record(db, addSession(db, {}).session_id, 'STU-0001');
    const r = scan(db, '09:50', 'STU-0001');
    assert.deepEqual([r.result, r.class_id, r.newSession.schedule_id], ['ACCEPTED', 'CLS-0003', 'SCH-0003']);
  });
});

describe('sessionPhase / missingStatus', () => {
  const s = { session_date: '2026-11-23', scheduled_start: '08:00', scheduled_end: '10:00', actual_start: '', actual_end: '', status: 'open' };
  const now = (date, time) => ({ date, time });
  it('follows the scheduled times', () => {
    assert.equal(sessionPhase(s, now('2026-11-22', '09:00')), 'upcoming');
    assert.equal(sessionPhase(s, now('2026-11-23', '07:59')), 'upcoming');
    assert.equal(sessionPhase(s, now('2026-11-23', '08:00')), 'in_progress');
    assert.equal(sessionPhase(s, now('2026-11-23', '10:00')), 'in_progress');
    assert.equal(sessionPhase(s, now('2026-11-23', '10:01')), 'ended');
    assert.equal(sessionPhase(s, now('2026-11-24', '00:00')), 'ended');
  });
  it('uses actual times, cancelled and closed', () => {
    assert.equal(sessionPhase({ ...s, actual_end: '11:00' }, now('2026-11-23', '10:30')), 'in_progress');
    assert.equal(sessionPhase({ ...s, status: 'cancelled' }, now('2026-11-23', '09:00')), 'cancelled');
    assert.equal(sessionPhase({ ...s, status: 'closed' }, now('2026-11-23', '09:00')), 'ended');
  });
  it('missingStatus is absent only after the end', () => {
    assert.equal(missingStatus(s, now('2026-11-23', '09:00')), 'not_scanned');
    assert.equal(missingStatus(s, now('2026-11-23', '07:50')), 'not_scanned');
    assert.equal(missingStatus(s, now('2026-11-23', '10:01')), 'absent');
  });
  it('manilaAt gives Manila date and time', () => {
    assert.deepEqual(manilaAt(Date.parse('2026-11-22T16:00:00Z')), { date: '2026-11-23', time: '00:00', iso: '2026-11-23T00:00:00+08:00' });
  });
});
