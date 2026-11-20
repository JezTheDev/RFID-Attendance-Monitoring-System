// Optional { from, to } date filters on instructor/student history actions.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, SESSIONS, withCode, CTX, clockAt } from './helpers/db.js';
import { dateRange } from '../src/utils.js';
import * as portal from '../src/handlers/portal.js';

const fieldError = (field) => (error) => {
  withCode('VALIDATION_ERROR')(error);
  if (!error.fields?.[field]) throw new Error(`expected fields.${field}, got ${JSON.stringify(error.fields)}`);
  return true;
};

describe('dateRange helper', () => {
  it('no range matches every date', () => {
    const range = dateRange({});
    assert.deepEqual([range.from, range.to, range.has('1999-01-01'), range.has('2099-12-31')], ['', '', true, true]);
    assert.equal(dateRange({ from: '', to: '' }).has('2026-11-16'), true);
  });

  it('includes the from and to days themselves, excludes the days outside', () => {
    const range = dateRange({ from: '2026-11-09', to: '2026-11-16' });
    assert.deepEqual(['2026-11-08', '2026-11-09', '2026-11-16', '2026-11-17'].map(range.has), [false, true, true, false]);
  });

  it('one bound only is open-ended', () => {
    assert.deepEqual([dateRange({ from: '2026-11-10' }).has('2030-01-01'), dateRange({ from: '2026-11-10' }).has('2026-11-09')], [true, false]);
    assert.deepEqual([dateRange({ to: '2026-11-10' }).has('2000-01-01'), dateRange({ to: '2026-11-10' }).has('2026-11-11')], [true, false]);
  });

  it('rejects a bad format or an impossible date, naming the real field', () => {
    assert.throws(() => dateRange({ from: '2026-1-5' }), fieldError('from'));
    assert.throws(() => dateRange({ from: '2026-02-30' }), fieldError('from'));
    assert.throws(() => dateRange({ to: '11/16/2026' }), fieldError('to'));
    assert.throws(() => dateRange({ from: 20261116 }), fieldError('from'));
    assert.throws(() => dateRange({ from: 'x', to: 'y' }), (e) => fieldError('from')(e) && fieldError('to')(e));
  });

  it('rejects from > to on the to field', () => {
    assert.throws(() => dateRange({ from: '2026-11-17', to: '2026-11-16' }), fieldError('to'));
  });

  it('allows up to 366 days (inclusive) and rejects 367', () => {
    assert.equal(dateRange({ from: '2026-01-01', to: '2027-01-01' }).has('2026-06-01'), true);
    assert.equal(dateRange({ from: '2024-01-01', to: '2024-12-31' }).has('2024-02-29'), true);
    assert.throws(() => dateRange({ from: '2026-01-01', to: '2027-01-02' }), fieldError('to'));
  });
});

// Extra CLS-0001 session a week earlier: STU-0001 has no record there (absent),
// plus a cancelled session on 2026-11-02. SES-0001 (2026-11-16): STU-0001 present.
function weekDb() {
  const db = makeDb();
  const base = db.ClassSessions[0];
  db.ClassSessions.push(
    { ...base, session_id: 'SES-0003', session_date: '2026-11-09' },
    { ...base, session_id: 'SES-0004', session_date: '2026-11-02', status: 'cancelled' },
  );
  return db;
}
const ANA = SESSIONS.instructorAna;
const ONLY_16 = { from: '2026-11-16', to: '2026-11-16' };
const ONLY_09 = { from: '2026-11-09', to: '2026-11-15' };
const ana = (s) => s.student_id === 'STU-0001';

describe('student.getHistory', () => {
  it('filters records and computes the rate inside the range', () => {
    const db = weekDb();
    const all = portal.studentHistory(db, {}, SESSIONS.student1, CTX);
    assert.deepEqual(all.records.map((r) => r.session_id), ['SES-0001', 'SES-0003', 'SES-0004']);
    assert.equal(all.totals.rate, 0.5);
    const r16 = portal.studentHistory(db, ONLY_16, SESSIONS.student1, CTX);
    assert.deepEqual([r16.records.map((r) => r.session_id), r16.totals.rate, r16.range], [['SES-0001'], 1, ONLY_16]);
    const r09 = portal.studentHistory(db, ONLY_09, SESSIONS.student1, CTX);
    assert.deepEqual([r09.records.map((r) => r.session_id), r09.totals.absent, r09.totals.rate], [['SES-0003'], 1, 0]);
  });

  it('an empty range returns no records and no rate', () => {
    const result = portal.studentHistory(weekDb(), { from: '2026-10-01', to: '2026-10-31' }, SESSIONS.student1, CTX);
    assert.deepEqual([result.records, result.totals.total, result.totals.rate], [[], 0, null]);
  });

  it('a student with a range still sees only their own records', () => {
    const result = portal.studentHistory(weekDb(), { student_id: 'STU-0004', from: '2026-11-01', to: '2026-11-30' }, SESSIONS.student1, CTX);
    assert.deepEqual(result.records.map((r) => r.class_id), ['CLS-0001', 'CLS-0001', 'CLS-0001']);
    assert.throws(() => portal.studentHistory(weekDb(), { class_id: 'CLS-0002', ...ONLY_16 }, SESSIONS.student1, CTX), withCode('FORBIDDEN'));
  });

  it('rejects bad input', () => {
    assert.throws(() => portal.studentHistory(weekDb(), { from: '2026-13-01' }, SESSIONS.student1, CTX), fieldError('from'));
  });
});

describe('student.getOverview', () => {
  it('totals, subjects and recent follow the range', () => {
    const db = weekDb();
    const all = portal.studentOverview(db, {}, SESSIONS.student1, CTX);
    assert.equal(all.totals.rate, 0.5);
    const r09 = portal.studentOverview(db, ONLY_09, SESSIONS.student1, CTX);
    assert.deepEqual([r09.totals.rate, r09.subjects[0].rate, r09.subjects[0].last.session_id, r09.recent.map((r) => r.session_id)],
      [0, 0, 'SES-0003', ['SES-0003']]);
    assert.deepEqual(r09.range, ONLY_09);
  });

  it('rejects from > to', () => {
    assert.throws(() => portal.studentOverview(weekDb(), { from: '2026-11-20', to: '2026-11-01' }, SESSIONS.student1, CTX), fieldError('to'));
  });
});

describe('instructor.listSessions', () => {
  it('lists only sessions inside the range (boundaries included)', () => {
    const db = weekDb();
    const ids = (req) => portal.instructorListSessions(db, { class_id: 'CLS-0001', ...req }, ANA, CTX).sessions.map((s) => s.session_id);
    assert.deepEqual(ids({}), ['SES-0001', 'SES-0003', 'SES-0004']);
    assert.deepEqual(ids({ from: '2026-11-02', to: '2026-11-09' }), ['SES-0003', 'SES-0004']);
    assert.deepEqual(ids(ONLY_16), ['SES-0001']);
  });

  it('keeps the ownership check and rejects bad input', () => {
    assert.throws(() => portal.instructorListSessions(weekDb(), { class_id: 'CLS-0002', ...ONLY_16 }, ANA, CTX), withCode('FORBIDDEN'));
    assert.throws(() => portal.instructorListSessions(weekDb(), { class_id: 'CLS-0001', to: '2026-11-31' }, ANA, CTX), fieldError('to'));
  });
});

describe('instructor.getStudentHistory', () => {
  it('filters records and totals inside the range', () => {
    const db = weekDb();
    const run = (req) => portal.instructorStudentHistory(db, { class_id: 'CLS-0001', student_id: 'STU-0001', ...req }, ANA, CTX);
    assert.equal(run({}).totals.rate, 0.5);
    const r16 = run(ONLY_16);
    assert.deepEqual([r16.records.map((r) => r.session_id), r16.totals.rate, r16.range], [['SES-0001'], 1, ONLY_16]);
  });

  it('rejects more than 366 days', () => {
    assert.throws(() => portal.instructorStudentHistory(weekDb(), { class_id: 'CLS-0001', student_id: 'STU-0001', from: '2025-01-01', to: '2026-11-20' }, ANA, CTX), fieldError('to'));
  });
});

describe('instructor.getClassRoster', () => {
  it('totals and sessions_held count only the range', () => {
    const db = weekDb();
    const run = (req) => portal.instructorClassRoster(db, { class_id: 'CLS-0001', ...req }, ANA, CTX);
    const all = run({});
    assert.deepEqual([all.class.sessions_held, all.students.find(ana).rate], [2, 0.5]);
    const r09 = run(ONLY_09);
    assert.deepEqual([r09.class.sessions_held, r09.students.find(ana).rate, r09.range], [1, 0, ONLY_09]);
  });

  it('keeps the ownership check and rejects bad input', () => {
    assert.throws(() => portal.instructorClassRoster(weekDb(), { class_id: 'CLS-0002', ...ONLY_16 }, ANA, CTX), withCode('FORBIDDEN'));
    assert.throws(() => portal.instructorClassRoster(weekDb(), { class_id: 'CLS-0001', from: 'today' }, ANA, CTX), fieldError('from'));
  });
});

describe('instructor.getClassReport', () => {
  it('sessions, marks, totals and cancelled count follow the range', () => {
    const db = weekDb();
    const run = (req) => portal.instructorClassReport(db, { class_id: 'CLS-0001', ...req }, ANA, CTX);
    const all = run({});
    assert.deepEqual([all.sessions.length, all.cancelled_sessions, all.students.find(ana).rate], [2, 1, 0.5]);
    const r16 = run(ONLY_16);
    assert.deepEqual([r16.sessions.map((s) => s.session_id), r16.cancelled_sessions, r16.students.find(ana).marks, r16.totals.rate],
      [['SES-0001'], 0, ['present'], 2 / 3]);
    assert.equal(run({ from: '2026-11-02', to: '2026-11-02' }).cancelled_sessions, 1);
  });

  it('bad format is a VALIDATION_ERROR on the real field', () => {
    const run = (req) => portal.instructorClassReport(weekDb(), { class_id: 'CLS-0001', ...req }, ANA, CTX);
    assert.throws(() => run({ from: 'bad' }), fieldError('from'));
    assert.throws(() => run({ to: 'bad' }), fieldError('to'));
    assert.throws(() => run({ from: '2026-11-17', to: '2026-11-16' }), fieldError('to'));
  });

  it('an open session inside the range stays not_scanned until it ends', () => {
    const db = weekDb();
    db.ClassSessions[0].status = 'open';
    const during = portal.instructorClassReport(db, { class_id: 'CLS-0001', ...ONLY_16 }, ANA, clockAt('2026-11-16T09:00:00+08:00'));
    const carla = during.students.find((s) => s.student_id === 'STU-0003');
    assert.deepEqual([carla.marks, carla.total, during.totals.absent], [['not_scanned'], 0, 0]);
  });
});
