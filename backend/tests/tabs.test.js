// Step 4a: every action declares the tabs it reads, writes and appends to
// (actions.js). Server.gs loads only those. Here every action runs once,
// through runAction, on a db that holds ONLY its declared tabs and is guarded
// strictly: reading an undeclared tab, or changing a tab not declared as
// written, throws. A representative request that succeeds walks the real path.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers/db.js';
import { makeCtx, setPassword } from './helpers/auth.js';
import { ACTIONS, AUTH_TABS, tabsFor, guardDb, runAction } from '../src/actions.js';
import { startSession } from '../src/auth/session.js';

const PASSWORD = 'Admin2026x';
const later = '2099-01-01T00:00:00+08:00';

// A device in maintenance that already has a (fake) key hash.
const addDevice = (db) => db.Devices.push({ device_id: 'DEV-CPE-101-01', room_id: 'RM-0001', device_name: 'Lab 1 Reader', device_key_hash: 'f'.repeat(64), status: 'maintenance', notes: '' });

// [action, who, request, setup(fullDb)?]
const CASES = [
  ['auth.login', null, { username: 'admin', password: PASSWORD }],
  ['auth.logout', 'admin', {}],
  ['auth.me', 'admin', {}],
  ['auth.changePassword', 'admin', { old_password: PASSWORD, new_password: 'Changed2026x' }],
  ['admin.getDashboard', 'admin', { date: '2026-11-16' }],
  ['admin.listAttendance', 'admin', { status: 'present', section_id: 'SEC-0001' }],
  ['admin.getAttendanceReport', 'admin', { group_by: 'section' }],
  ['admin.getStudentOptions', 'admin', {}],
  ['admin.listStudents', 'admin', {}],
  ['admin.getStudent', 'admin', { student_id: 'STU-0001' }],
  ['admin.listUnregisteredUids', 'admin', {}],
  ['admin.createStudent', 'admin', { student_number: '2024000099', first_name: 'Gio', last_name: 'Ramos', section_id: 'SEC-0001' }],
  ['admin.updateStudent', 'admin', { student_id: 'STU-0001', student_number: '2024000001', first_name: 'Carlita', last_name: 'Santos', section_id: 'SEC-0001', email: 's1@example.com' }],
  ['admin.setStudentStatus', 'admin', { student_id: 'STU-0001', status: 'inactive', reason: 'left the school' }],
  ['admin.assignCard', 'admin', { student_id: 'STU-0002', rfid_uid: '11223344' }],
  ['admin.revokeCard', 'admin', { student_id: 'STU-0001', reason: 'lost the card' }],
  ['admin.listTerms', 'admin', {}],
  ['admin.createTerm', 'admin', { term_name: '2nd Sem', start_date: '2027-01-11', end_date: '2027-05-21' }],
  ['admin.updateTerm', 'admin', { term_id: 'TRM-0001', term_name: '1st Semester', start_date: '2026-08-10', end_date: '2026-12-18' }],
  ['admin.setActiveTerm', 'admin', { term_id: 'TRM-0002' }, (db) => db.Terms.push({ ...db.Terms[0], term_id: 'TRM-0002', term_name: '2nd Sem', start_date: '2027-01-11', end_date: '2027-05-21', is_active: 'FALSE' })],
  ['admin.listPrograms', 'admin', {}],
  ['admin.createProgram', 'admin', { program_code: 'BSEE', program_name: 'Electrical Engineering' }],
  ['admin.updateProgram', 'admin', { program_id: 'PRG-0001', program_code: 'BSCpE', program_name: 'Computer Eng' }],
  ['admin.setProgramStatus', 'admin', { program_id: 'PRG-0002', status: 'inactive' }, (db) => db.Programs.push({ program_id: 'PRG-0002', program_code: 'BSEE', program_name: 'EE', status: 'active' })],
  ['admin.listSections', 'admin', {}],
  ['admin.createSection', 'admin', { program_id: 'PRG-0001', year_level: '4', section_name: '4A' }],
  ['admin.updateSection', 'admin', { section_id: 'SEC-0001', program_id: 'PRG-0001', year_level: '3', section_name: '3AA' }],
  ['admin.setSectionStatus', 'admin', { section_id: 'SEC-0009', status: 'inactive' }, (db) => db.Sections.push({ section_id: 'SEC-0009', program_id: 'PRG-0001', year_level: '4', section_name: '4Z', status: 'active' })],
  ['admin.listSubjects', 'admin', {}],
  ['admin.createSubject', 'admin', { subject_code: 'CPE399', subject_title: 'Thesis', units: '3' }],
  ['admin.updateSubject', 'admin', { subject_id: 'SUB-0003', subject_code: 'CPE303', subject_title: 'Embedded', units: '3' }],
  ['admin.setSubjectStatus', 'admin', { subject_id: 'SUB-0003', status: 'inactive' }],
  ['admin.listRooms', 'admin', {}],
  ['admin.createRoom', 'admin', { room_code: 'CPE-103', room_name: 'Lab 3', building: '' }],
  ['admin.updateRoom', 'admin', { room_id: 'RM-0002', room_code: 'CPE-102', room_name: 'Lab Two', building: '' }],
  ['admin.setRoomStatus', 'admin', { room_id: 'RM-0009', status: 'inactive' }, (db) => db.Rooms.push({ room_id: 'RM-0009', room_code: 'CPE-109', room_name: 'Spare', building: '', status: 'active' })],
  ['admin.listDevices', 'admin', {}, addDevice],
  ['admin.createDevice', 'admin', { device_name: 'Lab 1 Reader', room_id: 'RM-0001' }],
  ['admin.updateDevice', 'admin', { device_id: 'DEV-CPE-101-01', device_name: 'Front Reader' }, addDevice],
  ['admin.setDeviceStatus', 'admin', { device_id: 'DEV-CPE-101-01', status: 'active' }, addDevice],
  ['admin.assignDeviceRoom', 'admin', { device_id: 'DEV-CPE-101-01', room_id: 'RM-0002' }, addDevice],
  ['admin.generateDeviceKey', 'admin', { device_id: 'DEV-CPE-101-01' }, addDevice],
  ['admin.listInstructors', 'admin', {}],
  ['admin.createInstructor', 'admin', { username: 'carl', first_name: 'Carl', last_name: 'Uy', email: 'carl@example.com', department: 'CpE' }],
  ['admin.updateInstructor', 'admin', { instructor_id: 'INS-0002', username: 'ben', first_name: 'Benjamin', last_name: 'Cruz', email: 'ben@example.com', department: 'CpE' }],
  ['admin.setInstructorStatus', 'admin', { instructor_id: 'INS-0003', status: 'inactive' }, (db) => db.Instructors.push({ instructor_id: 'INS-0003', first_name: 'Cy', last_name: 'Go', email: 'cy@example.com', department: 'CpE', account_status: 'active' })],
  ['admin.listAdmins', 'admin', {}],
  ['admin.createAdmin', 'admin', { username: 'admin2', display_name: 'Second Admin', email: '' }],
  ['admin.updateAdmin', 'admin', { user_id: 'USR-0001', username: 'admin', display_name: 'The Boss', email: '' }],
  ['admin.setAdminStatus', 'admin', { user_id: 'USR-0009', status: 'inactive' }, (db) => db.Users.push({ ...db.Users[0], user_id: 'USR-0009', username: 'admin9' })],
  ['admin.resetPassword', 'admin', { user_id: 'USR-0004' }],
  ['admin.unlockUser', 'admin', { user_id: 'USR-0004' }, (db) => Object.assign(db.Users[3], { failed_attempts: '5', locked_until: later })],
  ['admin.getSettings', 'admin', {}],
  ['admin.updateSettings', 'admin', { changes: { duplicate_window_minutes: 10, lockout_minutes: 30 } }],
  ['admin.getClassOptions', 'admin', {}],
  ['admin.listClasses', 'admin', {}],
  ['admin.getClass', 'admin', { class_id: 'CLS-0001' }],
  ['admin.createClass', 'admin', { term_id: 'TRM-0001', subject_id: 'SUB-0003', section_id: 'SEC-0001', instructor_id: 'INS-0001', late_grace_minutes: '15' }],
  ['admin.updateClass', 'admin', { class_id: 'CLS-0001', instructor_id: 'INS-0001', late_grace_minutes: '10' }],
  ['admin.setClassStatus', 'admin', { class_id: 'CLS-0002', status: 'inactive' }],
  ['admin.addSchedule', 'admin', { class_id: 'CLS-0001', day_of_week: 'WED', start_time: '08:00', end_time: '10:00', room_id: 'RM-0001' }],
  ['admin.removeSchedule', 'admin', { schedule_id: 'SCH-0001' }],
  ['admin.enrollStudents', 'admin', { class_id: 'CLS-0002', student_ids: ['STU-0001'] }],
  ['admin.dropEnrollment', 'admin', { class_id: 'CLS-0001', student_id: 'STU-0003', reason: 'shifted' }],
  ['instructor.getDashboard', 'ana', { date: '2026-11-16' }],
  ['instructor.listSessions', 'ana', { class_id: 'CLS-0001' }],
  ['instructor.getSession', 'ana', { session_id: 'SES-0001' }],
  ['instructor.correctAttendance', 'ana', { session_id: 'SES-0001', student_id: 'STU-0003', status: 'late', reason: 'reader was offline' }],
  ['instructor.getClassReport', 'ana', { class_id: 'CLS-0001' }],
  ['instructor.getClassRoster', 'ana', { class_id: 'CLS-0001' }],
  ['instructor.getStudentHistory', 'ana', { class_id: 'CLS-0001', student_id: 'STU-0001' }],
  ['student.getOverview', 'student', {}],
  ['student.getHistory', 'student', {}],
  ['student.getProfile', 'student', {}],
];

const USER_OF = { admin: 'USR-0001', ana: 'USR-0002', student: 'USR-0004' };

// Runs one action on a strictly guarded db holding only its declared tabs.
function runDeclared(name, who, request, setup) {
  const ctx = makeCtx();
  const full = makeDb();
  setPassword(full, ctx, 'USR-0001', PASSWORD);
  if (setup) setup(full);
  const token = who ? startSession(full, full.Users.find((u) => u.user_id === USER_OF[who]), ctx).token : undefined;
  const spec = tabsFor(name);
  const db = {};
  [...spec.read, ...spec.append].forEach((tab) => { db[tab] = full[tab]; });
  const guarded = guardDb(db, spec, (tab) => { throw new Error(`${name} read the undeclared tab ${tab}`); });
  return runAction(guarded, { action: name, session_token: token, ...request }, ctx);
}

describe('tab declarations (step 4a)', () => {
  it('every action has a representative case below', () => {
    assert.deepEqual(CASES.map((c) => c[0]).sort(), Object.keys(ACTIONS).sort());
  });

  it('unknown action declares nothing', () => {
    assert.equal(tabsFor('nope.nothing'), null);
  });

  it('signed-in actions always read the session tabs; public ones do not need them', () => {
    assert.deepEqual(AUTH_TABS, ['AuthSessions', 'Users']);
    assert.ok(AUTH_TABS.every((tab) => tabsFor('auth.me').read.includes(tab)));
    assert.ok(!tabsFor('auth.logout').read.includes('Users'));
  });

  it('READ actions declare no writes or appends; WRITE actions append to AuditLog only by declaring it', () => {
    for (const [name, entry] of Object.entries(ACTIONS)) {
      const spec = tabsFor(name);
      if (entry.mode === 'read') assert.deepEqual([spec.write, spec.append], [[], []], name);
    }
  });

  it('portals and history never read AuditLog', () => {
    for (const name of ['instructor.getSession', 'student.getHistory', 'instructor.getStudentHistory', 'student.getOverview']) {
      assert.ok(![...tabsFor(name).read, ...tabsFor(name).append].includes('AuditLog'), name);
    }
  });

  for (const [name, who, request, setup] of CASES) {
    it(`${name} succeeds using only its declared tabs`, () => {
      runDeclared(name, who, request, setup);
    });
  }
});

describe('guardDb', () => {
  const spec = { read: ['Users', 'Students'], write: ['Users'], append: ['AuditLog'] };
  const make = () => {
    const full = makeDb();
    full.AuditLog.push({ audit_id: 'AUD-0001' });
    return guardDb({ Users: full.Users, Students: full.Students, AuditLog: full.AuditLog }, spec, (tab) => { throw new Error(`undeclared ${tab}`); });
  };

  it('a read-only tab cannot be changed, replaced or grown', () => {
    const db = make();
    assert.throws(() => { db.Students[0].first_name = 'X'; }, TypeError);
    assert.throws(() => { db.Students.push({}); }, TypeError);
    assert.throws(() => { db.Students = []; }, /not declared as written/);
  });

  it('a written tab can change', () => {
    const db = make();
    db.Users[0].display_name = 'Changed';
    db.Users = db.Users.filter(() => true);
    assert.equal(db.Users[0].display_name, 'Changed');
  });

  it('an append tab takes new rows, but its loaded rows are frozen', () => {
    const db = make();
    db.AuditLog.push({ audit_id: 'AUD-0002' });
    assert.equal(db.AuditLog.length, 2);
    assert.throws(() => { db.AuditLog[0].audit_id = 'AUD-9999'; }, TypeError);
  });

  it('an undeclared tab goes to onMissing', () => {
    const db = make();
    assert.throws(() => db.Attendance, /undeclared Attendance/);
  });
});
