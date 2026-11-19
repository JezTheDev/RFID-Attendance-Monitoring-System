// Step 4d (from the 4c review): one clock. Every timestamp, the audit log and
// "now" come from ctx.now(); session data carries its phase; sessions_held
// skips sessions that have not started yet.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, SESSIONS, clockAt } from './helpers/db.js';
import { writeAudit } from '../src/utils.js';
import { assignCard } from '../src/handlers/students.js';
import { getAdminDashboard } from '../src/handlers/dashboard.js';
import * as portal from '../src/handlers/portal.js';

const AT = '2026-11-18T08:00:00+08:00';

describe('one clock: ctx.now()', () => {
  it('writeAudit stamps the time from ctx.now()', () => {
    const db = makeDb();
    writeAudit(db, SESSIONS.admin, { action: 'TEST', entityType: 'X', entityId: '1' }, clockAt(AT));
    assert.equal(db.AuditLog[0].timestamp, AT);
  });

  it('a handler timestamp (assignCard) and its audit row use ctx.now()', () => {
    const db = makeDb();
    assignCard(db, { student_id: 'STU-0002', rfid_uid: 'A1B2C3D5' }, SESSIONS.admin, clockAt(AT));
    assert.equal(db.RfidCards.at(-1).assigned_at, AT);
    assert.equal(db.AuditLog.at(-1).timestamp, AT);
  });

  it('admin dashboard "online" follows ctx.now()', () => {
    const db = makeDb();
    db.Devices.push({ device_id: 'DEV-CPE-101-01', room_id: 'RM-0001', device_name: 'R', device_key_hash: '', status: 'active',
      firmware_version: '', battery_voltage: '', wifi_rssi: '', queue_count: '0', time_synced: '', last_seen_at: AT, last_heartbeat_at: '', notes: '' });
    const online = (iso) => getAdminDashboard(db, { date: '2026-11-18' }, SESSIONS.admin, clockAt(iso)).devices[0].online;
    assert.equal(online('2026-11-18T08:01:00+08:00'), true);
    assert.equal(online('2026-11-19T08:00:00+08:00'), false);
  });
});

// SES-0001: CLS-0001, Monday 2026-11-16 08:00-10:00, made "open" (an early tap).
function openDb() {
  const db = makeDb();
  db.ClassSessions[0].status = 'open';
  return db;
}
const BEFORE = clockAt('2026-11-16T07:50:00+08:00');
const DURING = clockAt('2026-11-16T09:00:00+08:00');
const AFTER = clockAt('2026-11-16T12:00:00+08:00');

describe('session phase in session data', () => {
  it('instructor.getSession has phase upcoming / in_progress / ended', () => {
    const db = openDb();
    const phase = (ctx) => portal.instructorGetSession(db, { session_id: 'SES-0001' }, SESSIONS.instructorAna, ctx).session.phase;
    assert.deepEqual([phase(BEFORE), phase(DURING), phase(AFTER)], ['upcoming', 'in_progress', 'ended']);
    db.ClassSessions[0].status = 'cancelled';
    assert.equal(phase(DURING), 'cancelled');
  });

  it('instructor dashboard rows have a phase, also without a ClassSession row', () => {
    const db = openDb();
    const row = (ctx) => portal.instructorDashboard(db, { date: '2026-11-16' }, SESSIONS.instructorAna, ctx).sessions[0];
    assert.equal(row(DURING).phase, 'in_progress');
    db.ClassSessions.splice(0, 1);
    assert.equal(row(BEFORE).phase, 'upcoming');
    assert.equal(row(AFTER).phase, 'ended');
  });

  it('admin dashboard sessions have a phase, also without a ClassSession row', () => {
    const db = openDb();
    const row = (ctx) => getAdminDashboard(db, { date: '2026-11-16' }, SESSIONS.admin, ctx).sessions[0];
    assert.equal(row(DURING).phase, 'in_progress');
    db.ClassSessions.splice(0, 1);
    assert.equal(row(BEFORE).phase, 'upcoming');
  });
});

describe('sessions_held skips upcoming sessions', () => {
  it('an open session that has not started is not held yet (dashboard summary and roster)', () => {
    const db = openDb();
    const held = (ctx) => [
      portal.instructorDashboard(db, { date: '2026-11-16' }, SESSIONS.instructorAna, ctx).classes[0].sessions_held,
      portal.instructorClassRoster(db, { class_id: 'CLS-0001' }, SESSIONS.instructorAna, ctx).class.sessions_held,
    ];
    assert.deepEqual(held(BEFORE), [0, 0]);
    assert.deepEqual(held(DURING), [1, 1]);
  });
});
