// Editor-only maintenance jobs (backend/src/maintenance.js).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers/db.js';
import { findScheduleClashes } from '../src/maintenance.js';

describe('findScheduleClashes', () => {
  // CLS-0001: MON 08:00-10:00 RM-0001, INS-0001, SEC-0001. CLS-0002: TUE, RM-0002, INS-0002, SEC-0002.
  const moveClass2 = (db, fields) => {
    Object.assign(db.Schedules[1], { day_of_week: 'MON', start_time: '09:00', end_time: '11:00' }, fields.schedule || {});
    Object.assign(db.Classes[1], fields.klass || {});
  };

  it('finds nothing when no active classes overlap', () => {
    assert.deepEqual(findScheduleClashes(makeDb()), []);
  });

  it('reports a shared room, instructor or section, without changing anything', () => {
    const db = makeDb();
    moveClass2(db, { schedule: { room_id: 'RM-0001' }, klass: { instructor_id: 'INS-0001', section_id: 'SEC-0001' } });
    const before = JSON.stringify(db);
    const lines = findScheduleClashes(db);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /CPE301 3A .*CPE302 3B/);
    assert.match(lines[0], /MON/);
    assert.match(lines[0], /room CPE-101/);
    assert.match(lines[0], /instructor Ana Reyes/);
    assert.match(lines[0], /section 3A/);
    assert.equal(JSON.stringify(db), before);
  });

  it('touching times (10:00 end, 10:00 start) are not a clash', () => {
    const db = makeDb();
    moveClass2(db, { schedule: { room_id: 'RM-0001', start_time: '10:00', end_time: '12:00' } });
    assert.deepEqual(findScheduleClashes(db), []);
  });

  for (const [label, change] of [
    ['an inactive class', { klass: { status: 'inactive' } }],
    ['an inactive schedule', { schedule: { status: 'inactive' } }],
    ['another term', { klass: { term_id: 'TRM-0002' } }],
    ['another day', { schedule: { day_of_week: 'TUE' } }],
  ]) {
    it(`ignores ${label}`, () => {
      const db = makeDb();
      moveClass2(db, { schedule: { room_id: 'RM-0001', ...change.schedule }, klass: change.klass });
      assert.deepEqual(findScheduleClashes(db), []);
    });
  }
});
