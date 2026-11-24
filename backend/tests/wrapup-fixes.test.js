// Backend wrap-up (docs/archive/FINAL_BACKEND_REVIEW.md): I1, I3, D12 and the small Minor fixes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, SESSIONS, withCode, CTX } from './helpers/db.js';
import { makeCtx, setPassword } from './helpers/auth.js';
import { runAction, runDeviceAction } from '../src/actions.js';
import { startSession } from '../src/auth/session.js';
import * as portal from '../src/handlers/portal.js';
import { adminCorrectAttendance } from '../src/handlers/attendance.js';
import { setStudentStatus, revokeCard, createStudent } from '../src/handlers/students.js';
import { createInstructor } from '../src/handlers/instructors.js';
import { dropEnrollment } from '../src/handlers/classes.js';
import { createDevice, updateDevice, setDeviceStatus, generateDeviceKey } from '../src/handlers/devices.js';

const PW = 'Pass2026x';
const call = (db, ctx, action, token, extra = {}) => runAction(db, { action, session_token: token, ...extra }, ctx);
const login = (db, ctx, username) => runAction(db, { action: 'auth.login', username, password: PW }, ctx).session_token;
const snapshot = (db) => JSON.stringify([db.Attendance, db.AuditLog]);
const LONG = 'x'.repeat(501);

describe('I1: deactivating a user signs out all their sessions', () => {
  function setup() {
    const db = makeDb();
    const ctx = makeCtx({ startMs: Date.parse('2026-11-20T09:00:00+08:00') });
    ['USR-0003', 'USR-0004'].forEach((id) => setPassword(db, ctx, id, PW));
    const admin = startSession(db, db.Users[0], ctx).token;
    return { db, ctx, admin };
  }

  it('student: the old token fails after deactivate -> reactivate', () => {
    const { db, ctx, admin } = setup();
    const token = login(db, ctx, '2024000001');
    call(db, ctx, 'admin.setStudentStatus', admin, { student_id: 'STU-0001', status: 'inactive', reason: 'phone stolen' });
    call(db, ctx, 'admin.setStudentStatus', admin, { student_id: 'STU-0001', status: 'active', reason: 'phone found' });
    assert.throws(() => call(db, ctx, 'student.getProfile', token), withCode('NOT_SIGNED_IN'));
    assert.ok(login(db, ctx, '2024000001'), 'a new sign-in still works');
  });

  it('instructor: the old token fails after deactivate -> reactivate', () => {
    const { db, ctx, admin } = setup();
    db.Classes.find((c) => c.class_id === 'CLS-0002').status = 'inactive'; // Ben must have no active class
    const token = login(db, ctx, 'ben');
    call(db, ctx, 'admin.setInstructorStatus', admin, { instructor_id: 'INS-0002', status: 'inactive' });
    call(db, ctx, 'admin.setInstructorStatus', admin, { instructor_id: 'INS-0002', status: 'active' });
    assert.throws(() => call(db, ctx, 'auth.me', token), withCode('NOT_SIGNED_IN'));
    assert.ok(db.AuthSessions.filter((s) => s.user_id === 'USR-0003').every((s) => s.revoked === 'TRUE'));
  });
});

describe('I3: instructors cannot correct attendance in an inactive class', () => {
  const req = { session_id: 'SES-0001', student_id: 'STU-0003', status: 'late', reason: 'reader was offline' };
  const inactive = () => {
    const db = makeDb();
    db.Classes.find((c) => c.class_id === 'CLS-0001').status = 'inactive';
    return db;
  };

  it('instructor gets CLASS_INACTIVE and nothing is written', () => {
    const db = inactive();
    const before = snapshot(db);
    assert.throws(() => portal.instructorCorrectAttendance(db, req, SESSIONS.instructorAna, CTX), withCode('CLASS_INACTIVE'));
    assert.equal(snapshot(db), before);
  });

  it('instructor can still read the inactive class session', () => {
    const data = portal.instructorGetSession(inactive(), { session_id: 'SES-0001' }, SESSIONS.instructorAna, CTX);
    assert.equal(data.session.session_id, 'SES-0001');
  });

  it('admin can still correct it', () => {
    const db = inactive();
    assert.equal(adminCorrectAttendance(db, req, SESSIONS.admin, CTX).status, 'late');
  });
});

describe('M5: no correction before the session starts', () => {
  it('refuses a correction on an upcoming session (instructor and admin)', () => {
    const db = makeDb();
    db.ClassSessions.push({ ...db.ClassSessions[0], session_id: 'SES-0009', session_date: '2026-11-20', scheduled_start: '13:00', scheduled_end: '15:00', status: 'open' });
    const req = { session_id: 'SES-0009', student_id: 'STU-0002', status: 'present', reason: 'marking ahead of time' };
    assert.throws(() => portal.instructorCorrectAttendance(db, req, SESSIONS.instructorAna, CTX), withCode('SESSION_NOT_STARTED'));
    assert.throws(() => adminCorrectAttendance(db, req, SESSIONS.admin, CTX), withCode('SESSION_NOT_STARTED'));
  });
});

describe('D12: instructor.getRecentActivity', () => {
  const recent = (db, request = {}, session = SESSIONS.instructorAna) => portal.instructorRecentActivity(db, request, session, CTX);

  it('lists only rows of the instructor\'s own classes, newest first, with student, class, time and effective status', () => {
    const db = makeDb();
    db.Attendance[1].scanned_at = '2026-11-16T08:09:00+08:00';
    db.Attendance[1].override_status = 'present';
    const data = recent(db);
    assert.deepEqual(data.items.map((r) => r.attendance_id), ['ATT-00002', 'ATT-00001']);
    assert.deepEqual(data.items[0], {
      attendance_id: 'ATT-00002', session_id: 'SES-0001', session_date: '2026-11-16', class_id: 'CLS-0001', class_label: 'CPE301 3A',
      student_id: 'STU-0002', student_number: '2024000002', student_name: 'Dino Garcia',
      scanned_at: '2026-11-16T08:09:00+08:00', status: 'present', source: 'device', sync_mode: 'online', corrected: true,
    });
    assert.equal(data.has_more, false);
  });

  it('limit: default 20, at most 50; has_more tells if there are older rows', () => {
    const db = makeDb();
    const one = recent(db, { limit: 1 });
    assert.equal(one.items.length, 1);
    assert.equal(one.has_more, true);
    assert.equal(recent(db, { limit: 999 }).limit, 50);
    assert.equal(recent(db).limit, 20);
    assert.throws(() => recent(db, { limit: 0 }), withCode('VALIDATION_ERROR'));
    assert.throws(() => recent(db, { limit: 'x' }), withCode('VALIDATION_ERROR'));
  });

  it('class_id filter: own class only', () => {
    const db = makeDb();
    assert.equal(recent(db, { class_id: 'CLS-0001' }).items.length, 2);
    assert.throws(() => recent(db, { class_id: 'CLS-0002' }), withCode('FORBIDDEN'));
    assert.deepEqual(recent(db, {}, SESSIONS.instructorBen).items.map((r) => r.attendance_id), ['ATT-00003']);
  });

  it('is instructor-only on the server', () => {
    const db = makeDb();
    const ctx = makeCtx();
    const token = startSession(db, db.Users[3], ctx).token; // a student
    assert.throws(() => call(db, ctx, 'instructor.getRecentActivity', token), withCode('FORBIDDEN'));
  });
});

describe('M1: free-text length limits', () => {
  it('correction reason over 500 characters is refused', () => {
    const db = makeDb();
    const req = { session_id: 'SES-0001', student_id: 'STU-0003', status: 'late', reason: LONG };
    assert.throws(() => portal.instructorCorrectAttendance(db, req, SESSIONS.instructorAna, CTX), withCode('VALIDATION_ERROR'));
  });

  it('status / revoke / drop reasons and device notes over 500 characters are refused', () => {
    const db = makeDb();
    assert.throws(() => setStudentStatus(db, { student_id: 'STU-0001', status: 'inactive', reason: LONG }, SESSIONS.admin, CTX), withCode('VALIDATION_ERROR'));
    assert.throws(() => revokeCard(db, { student_id: 'STU-0001', reason: LONG }, SESSIONS.admin, CTX), withCode('VALIDATION_ERROR'));
    assert.throws(() => dropEnrollment(db, { class_id: 'CLS-0001', student_id: 'STU-0003', reason: LONG }, SESSIONS.admin, CTX), withCode('VALIDATION_ERROR'));
    assert.throws(() => createDevice(db, { device_name: 'Reader', room_id: 'RM-0001', notes: LONG }, SESSIONS.admin, CTX), withCode('VALIDATION_ERROR'));
  });

  it('submitScans keeps the scans but ignores a firmware_version longer than 32 characters', () => {
    const db = makeDb();
    const ctx = makeCtx({ startMs: Date.parse('2026-11-23T08:10:00+08:00') });
    const deviceId = createDevice(db, { device_name: 'Reader', room_id: 'RM-0001' }, SESSIONS.admin, ctx).device_id;
    const key = generateDeviceKey(db, { device_id: deviceId }, SESSIONS.admin, ctx).device_key;
    setDeviceStatus(db, { device_id: deviceId, status: 'active' }, SESSIONS.admin, ctx);
    const scan = { scan_id: `${deviceId}-000001-000001`, rfid_uid: 'A1B2C3D4', scanned_at: Date.parse('2026-11-23T08:05:00+08:00') / 1000, time_quality: 'ntp', sync_mode: 'live' };
    const data = runDeviceAction(db, { action: 'device.submitScans', device_id: deviceId, device_key: key, sent_at: 0, firmware_version: 'v'.repeat(33), scans: [scan] }, ctx);
    assert.equal(data.results[0].result, 'ACCEPTED');
    assert.equal(db.Devices[0].firmware_version, '');
  });
});

describe('M7: email uniqueness ignores case for students and instructors', () => {
  const mixedCase = () => {
    const db = makeDb();
    db.Users[1].email = 'Ana.Reyes@Example.com';
    return db;
  };

  it('student', () => {
    const input = { student_number: '2024000099', first_name: 'Gio', last_name: 'Ramos', section_id: 'SEC-0001', email: 'ana.reyes@example.com' };
    assert.throws(() => createStudent(mixedCase(), input, SESSIONS.admin, makeCtx()), withCode('VALIDATION_ERROR'));
  });

  it('instructor', () => {
    const input = { username: 'carl', first_name: 'Carl', last_name: 'Uy', email: 'ana.reyes@example.com', department: 'CpE' };
    assert.throws(() => createInstructor(mixedCase(), input, SESSIONS.admin, makeCtx()), withCode('VALIDATION_ERROR'));
  });
});

describe('M9: a retired device cannot be edited', () => {
  it('updateDevice gives DEVICE_RETIRED', () => {
    const db = makeDb();
    const id = createDevice(db, { device_name: 'Reader', room_id: 'RM-0001' }, SESSIONS.admin, CTX).device_id;
    setDeviceStatus(db, { device_id: id, status: 'retired' }, SESSIONS.admin, CTX);
    assert.throws(() => updateDevice(db, { device_id: id, device_name: 'New name' }, SESSIONS.admin, CTX), withCode('DEVICE_RETIRED'));
  });
});
