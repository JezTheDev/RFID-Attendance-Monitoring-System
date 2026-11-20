// Every action and which role may call it, plus runAction(), the gate every
// request goes through. Server.gs (backend/apps-script) calls RFID.runAction;
// the code is bundled into Bundle.gs by tools/build_apps_script.mjs.
//
// role: 'public' (no session), 'any' (any signed-in user), or an exact role.
// Handlers are called as run(db, request, session, ctx).
import { AppError } from './utils.js';
import {
  PUBLIC, ANY, PASSWORD_CHANGE_ALLOWED, authorize,
} from './auth/session.js';
import * as account from './auth/account.js';
import * as adminUsers from './auth/admin-users.js';
import { getAdminDashboard } from './handlers/dashboard.js';
import {
  getStudentOptions, listStudents, getStudent, createStudent, updateStudent,
  setStudentStatus, assignCard, revokeCard, listUnregisteredUids,
} from './handlers/students.js';
import * as academic from './handlers/academic.js';
import * as instructors from './handlers/instructors.js';
import * as portal from './handlers/portal.js';
import * as classes from './handlers/classes.js';
import * as admins from './handlers/admins.js';
import * as devices from './handlers/devices.js';
import * as settings from './handlers/settings.js';
import * as attendance from './handlers/attendance.js';
import { authenticateDevice } from './auth/device-auth.js';
import { submitScans, heartbeat, getRoster } from './handlers/device.js';

export const READ = 'read';
export const WRITE = 'write';

// Tabs: Server.gs loads only what an action declares (step 4a).
//   reads   - loaded fully (space-separated tab names)
//   writes  - may change; saved if they did (also loaded fully)
//   appends - append-only: only the header and LAST row are loaded (enough
//             for the next id); loaded rows are frozen, new rows are appended
// Signed-in actions also read AUTH_TABS (the session check).
export const AUTH_TABS = Object.freeze(['AuthSessions', 'Users']);
const CLASS_REF = 'Terms Programs Sections Subjects Rooms Instructors Students Classes Schedules Enrollments';
const PORTAL = `${CLASS_REF} ClassSessions Attendance RfidCards`;

export const ACTIONS = Object.freeze({
  'auth.login': { run: account.login, mode: WRITE, role: PUBLIC,
    reads: 'Users Settings AuthSessions Instructors Students', writes: 'Users AuthSessions', appends: 'AuditLog' },
  'auth.logout': { run: account.logout, mode: WRITE, role: PUBLIC,
    reads: 'AuthSessions', writes: 'AuthSessions' },
  'auth.me': { run: account.me, mode: READ, role: ANY,
    reads: 'Instructors Students' },
  'auth.changePassword': { run: account.changePassword, mode: WRITE, role: ANY,
    writes: 'Users AuthSessions', appends: 'AuditLog' },
  'admin.getDashboard': { run: getAdminDashboard, mode: READ, role: 'admin',
    reads: 'Attendance ClassSessions Classes Devices Enrollments Instructors RfidCards Rooms ScanLog Schedules Settings Students Subjects Terms' },
  'admin.listAttendance': { run: attendance.listAttendance, mode: READ, role: 'admin',
    reads: 'Attendance ClassSessions Classes Rooms Students' },
  'admin.getAttendanceReport': { run: attendance.getAttendanceReport, mode: READ, role: 'admin',
    reads: 'Attendance ClassSessions Classes Devices Enrollments Instructors Programs Rooms Sections Settings Students Subjects' },
  'admin.correctAttendance': { run: attendance.adminCorrectAttendance, mode: WRITE, role: 'admin',
    reads: PORTAL, writes: 'Attendance', appends: 'AuditLog' },
  'admin.getStudentOptions': { run: getStudentOptions, mode: READ, role: 'admin',
    reads: 'Programs Sections' },
  'admin.listStudents': { run: listStudents, mode: READ, role: 'admin',
    reads: 'Programs RfidCards Sections Students' },
  'admin.getStudent': { run: getStudent, mode: READ, role: 'admin',
    reads: 'Attendance Classes Enrollments Programs RfidCards Sections Students Subjects' },
  'admin.listUnregisteredUids': { run: listUnregisteredUids, mode: READ, role: 'admin',
    reads: 'Devices RfidCards Rooms ScanLog' },
  'admin.createStudent': { run: createStudent, mode: WRITE, role: 'admin',
    reads: 'Classes Enrollments Programs Sections Settings Students Terms', writes: 'Students Users Enrollments', appends: 'AuditLog' },
  'admin.updateStudent': { run: updateStudent, mode: WRITE, role: 'admin',
    reads: 'Classes Enrollments Programs Sections Settings Students Terms', writes: 'Students Users Settings Enrollments', appends: 'AuditLog' },
  'admin.setStudentStatus': { run: setStudentStatus, mode: WRITE, role: 'admin',
    reads: 'RfidCards Settings Students', writes: 'Students Users RfidCards Settings', appends: 'AuditLog' },
  'admin.assignCard': { run: assignCard, mode: WRITE, role: 'admin',
    reads: 'RfidCards Settings Students', writes: 'RfidCards Settings', appends: 'AuditLog' },
  'admin.revokeCard': { run: revokeCard, mode: WRITE, role: 'admin',
    reads: 'RfidCards Settings Students', writes: 'RfidCards Settings', appends: 'AuditLog' },
  'admin.listTerms': { run: academic.listTerms, mode: READ, role: 'admin',
    reads: 'Classes Terms' },
  'admin.createTerm': { run: academic.createTerm, mode: WRITE, role: 'admin',
    reads: 'ClassSessions Classes Terms', writes: 'Terms', appends: 'AuditLog' },
  'admin.updateTerm': { run: academic.updateTerm, mode: WRITE, role: 'admin',
    reads: 'ClassSessions Classes Terms', writes: 'Terms', appends: 'AuditLog' },
  'admin.setActiveTerm': { run: academic.setActiveTerm, mode: WRITE, role: 'admin',
    reads: 'Terms', writes: 'Terms', appends: 'AuditLog' },
  'admin.listPrograms': { run: academic.listPrograms, mode: READ, role: 'admin',
    reads: 'Programs Sections Students' },
  'admin.createProgram': { run: academic.createProgram, mode: WRITE, role: 'admin',
    reads: 'Programs', writes: 'Programs', appends: 'AuditLog' },
  'admin.updateProgram': { run: academic.updateProgram, mode: WRITE, role: 'admin',
    reads: 'Programs', writes: 'Programs', appends: 'AuditLog' },
  'admin.setProgramStatus': { run: academic.setProgramStatus, mode: WRITE, role: 'admin',
    reads: 'Programs Sections Students', writes: 'Programs', appends: 'AuditLog' },
  'admin.listSections': { run: academic.listSections, mode: READ, role: 'admin',
    reads: 'Classes Programs Sections Students' },
  'admin.createSection': { run: academic.createSection, mode: WRITE, role: 'admin',
    reads: 'Programs Sections Students', writes: 'Sections', appends: 'AuditLog' },
  'admin.updateSection': { run: academic.updateSection, mode: WRITE, role: 'admin',
    reads: 'Programs Sections Students', writes: 'Sections', appends: 'AuditLog' },
  'admin.setSectionStatus': { run: academic.setSectionStatus, mode: WRITE, role: 'admin',
    reads: 'Classes Sections Students', writes: 'Sections', appends: 'AuditLog' },
  'admin.listSubjects': { run: academic.listSubjects, mode: READ, role: 'admin',
    reads: 'Classes Subjects' },
  'admin.createSubject': { run: academic.createSubject, mode: WRITE, role: 'admin',
    reads: 'Subjects', writes: 'Subjects', appends: 'AuditLog' },
  'admin.updateSubject': { run: academic.updateSubject, mode: WRITE, role: 'admin',
    reads: 'Subjects', writes: 'Subjects', appends: 'AuditLog' },
  'admin.setSubjectStatus': { run: academic.setSubjectStatus, mode: WRITE, role: 'admin',
    reads: 'Classes Subjects', writes: 'Subjects', appends: 'AuditLog' },
  'admin.listRooms': { run: academic.listRooms, mode: READ, role: 'admin',
    reads: 'Devices Rooms Schedules' },
  'admin.createRoom': { run: academic.createRoom, mode: WRITE, role: 'admin',
    reads: 'Rooms', writes: 'Rooms', appends: 'AuditLog' },
  'admin.updateRoom': { run: academic.updateRoom, mode: WRITE, role: 'admin',
    reads: 'Rooms', writes: 'Rooms', appends: 'AuditLog' },
  'admin.setRoomStatus': { run: academic.setRoomStatus, mode: WRITE, role: 'admin',
    reads: 'Devices Rooms Schedules Classes', writes: 'Rooms', appends: 'AuditLog' },
  'admin.listDevices': { run: devices.listDevices, mode: READ, role: 'admin',
    reads: 'Devices Rooms' },
  'admin.createDevice': { run: devices.createDevice, mode: WRITE, role: 'admin',
    reads: 'Rooms', writes: 'Devices', appends: 'AuditLog' },
  'admin.updateDevice': { run: devices.updateDevice, mode: WRITE, role: 'admin',
    writes: 'Devices', appends: 'AuditLog' },
  'admin.setDeviceStatus': { run: devices.setDeviceStatus, mode: WRITE, role: 'admin',
    writes: 'Devices', appends: 'AuditLog' },
  'admin.assignDeviceRoom': { run: devices.assignDeviceRoom, mode: WRITE, role: 'admin',
    reads: 'Rooms', writes: 'Devices', appends: 'AuditLog' },
  'admin.generateDeviceKey': { run: devices.generateDeviceKey, mode: WRITE, role: 'admin',
    writes: 'Devices', appends: 'AuditLog' },
  'admin.listInstructors': { run: instructors.listInstructors, mode: READ, role: 'admin',
    reads: 'Classes Instructors' },
  'admin.createInstructor': { run: instructors.createInstructor, mode: WRITE, role: 'admin',
    reads: 'Instructors Settings', writes: 'Instructors Users', appends: 'AuditLog' },
  'admin.updateInstructor': { run: instructors.updateInstructor, mode: WRITE, role: 'admin',
    reads: 'Instructors', writes: 'Instructors Users', appends: 'AuditLog' },
  'admin.setInstructorStatus': { run: instructors.setInstructorStatus, mode: WRITE, role: 'admin',
    reads: 'Classes Instructors', writes: 'Instructors Users', appends: 'AuditLog' },
  'admin.listAdmins': { run: admins.listAdmins, mode: READ, role: 'admin' },
  'admin.createAdmin': { run: admins.createAdmin, mode: WRITE, role: 'admin',
    reads: 'Settings', writes: 'Users', appends: 'AuditLog' },
  'admin.updateAdmin': { run: admins.updateAdmin, mode: WRITE, role: 'admin',
    writes: 'Users', appends: 'AuditLog' },
  'admin.setAdminStatus': { run: admins.setAdminStatus, mode: WRITE, role: 'admin',
    writes: 'Users AuthSessions', appends: 'AuditLog' },
  'admin.resetPassword': { run: adminUsers.resetPassword, mode: WRITE, role: 'admin',
    reads: 'Settings', writes: 'Users AuthSessions', appends: 'AuditLog' },
  'admin.unlockUser': { run: adminUsers.unlockUser, mode: WRITE, role: 'admin',
    writes: 'Users', appends: 'AuditLog' },
  'admin.getSettings': { run: settings.getSettings, mode: READ, role: 'admin',
    reads: 'Settings' },
  'admin.updateSettings': { run: settings.updateSettings, mode: WRITE, role: 'admin',
    writes: 'Settings', appends: 'AuditLog' },
  'admin.getClassOptions': { run: classes.getClassOptions, mode: READ, role: 'admin',
    reads: CLASS_REF },
  'admin.listClasses': { run: classes.listClasses, mode: READ, role: 'admin',
    reads: CLASS_REF },
  'admin.getClass': { run: classes.getClass, mode: READ, role: 'admin',
    reads: CLASS_REF },
  'admin.createClass': { run: classes.createClass, mode: WRITE, role: 'admin',
    reads: CLASS_REF, writes: 'Classes Enrollments', appends: 'AuditLog' },
  'admin.updateClass': { run: classes.updateClass, mode: WRITE, role: 'admin',
    reads: CLASS_REF, writes: 'Classes', appends: 'AuditLog' },
  'admin.setClassStatus': { run: classes.setClassStatus, mode: WRITE, role: 'admin',
    reads: CLASS_REF, writes: 'Classes', appends: 'AuditLog' },
  'admin.addSchedule': { run: classes.addSchedule, mode: WRITE, role: 'admin',
    reads: CLASS_REF, writes: 'Schedules', appends: 'AuditLog' },
  'admin.removeSchedule': { run: classes.removeSchedule, mode: WRITE, role: 'admin',
    reads: CLASS_REF, writes: 'Schedules', appends: 'AuditLog' },
  'admin.enrollStudents': { run: classes.enrollStudents, mode: WRITE, role: 'admin',
    reads: CLASS_REF, writes: 'Enrollments', appends: 'AuditLog' },
  'admin.dropEnrollment': { run: classes.dropEnrollment, mode: WRITE, role: 'admin',
    reads: CLASS_REF, writes: 'Enrollments', appends: 'AuditLog' },
  'instructor.getDashboard': { run: portal.instructorDashboard, mode: READ, role: 'instructor',
    reads: PORTAL },
  'instructor.listSessions': { run: portal.instructorListSessions, mode: READ, role: 'instructor',
    reads: PORTAL },
  'instructor.getSession': { run: portal.instructorGetSession, mode: READ, role: 'instructor',
    reads: PORTAL },
  'instructor.correctAttendance': { run: portal.instructorCorrectAttendance, mode: WRITE, role: 'instructor',
    reads: PORTAL, writes: 'Attendance', appends: 'AuditLog' },
  'instructor.getClassReport': { run: portal.instructorClassReport, mode: READ, role: 'instructor',
    reads: PORTAL },
  'instructor.getClassRoster': { run: portal.instructorClassRoster, mode: READ, role: 'instructor',
    reads: PORTAL },
  'instructor.getStudentHistory': { run: portal.instructorStudentHistory, mode: READ, role: 'instructor',
    reads: PORTAL },
  'student.getOverview': { run: portal.studentOverview, mode: READ, role: 'student',
    reads: PORTAL },
  'student.getHistory': { run: portal.studentHistory, mode: READ, role: 'student',
    reads: PORTAL },
  'student.getProfile': { run: portal.studentGetProfile, mode: READ, role: 'student',
    reads: PORTAL },
});

const words = (text) => (text ? text.split(' ') : []);

// { read, write, append } tab names for an action, or null if it is unknown.
export function tabsFor(name) {
  const action = findAction(name);
  if (!action) return null;
  const write = words(action.writes);
  const read = [...new Set([...(action.role === PUBLIC ? [] : AUTH_TABS), ...words(action.reads), ...write])];
  return { read, write, append: words(action.appends).filter((tab) => !read.includes(tab)) };
}

const isTab = (name) => typeof name === 'string' && /^[A-Z]/.test(name);

// Wraps a db that holds only the declared tabs:
// - rows of read-only and append tabs are frozen (and read-only arrays too),
//   so an undeclared change throws instead of being silently not saved;
// - replacing a tab that is not declared as written throws;
// - reading a tab that was not loaded calls onMissing(tab), whose result is
//   kept (and may change). Tests throw there; Server.gs loads the tab and warns.
export function guardDb(db, spec, onMissing) {
  const lazy = new Set();
  Object.keys(db).forEach((tab) => {
    if (spec.write.includes(tab)) return;
    db[tab].forEach((row) => Object.freeze(row));
    if (!spec.append.includes(tab)) Object.freeze(db[tab]);
  });
  return new Proxy(db, {
    get(target, prop) {
      if (isTab(prop) && !(prop in target)) {
        target[prop] = onMissing(prop);
        lazy.add(prop);
      }
      return target[prop];
    },
    set(target, prop, value) {
      if (isTab(prop) && !spec.write.includes(prop) && !lazy.has(prop)) {
        throw new Error(`Tab ${prop} is not declared as written by this action.`);
      }
      target[prop] = value;
      return true;
    },
  });
}

export function findAction(name) {
  return Object.prototype.hasOwnProperty.call(ACTIONS, name) ? ACTIONS[name] : null;
}

// Looks the action up, checks the session, the role and the forced password
// change, then runs it. Throws AppError; error.commit === true means the
// changes made so far must still be saved (failed logins).
export function runAction(db, request, ctx) {
  const name = String(request.action || '');
  const action = findAction(name);
  if (!action) throw new AppError('UNKNOWN_ACTION', `Unknown action: ${name}`);
  if (action.role === PUBLIC) return action.run(db, request, null, ctx);

  const session = authorize(db, request.session_token, ctx);
  if (action.role !== ANY && session.role !== action.role) {
    throw new AppError('FORBIDDEN', 'You do not have access to this information.');
  }
  if (session.must_change_password && !PASSWORD_CHANGE_ALLOWED.includes(name)) {
    throw new AppError('PASSWORD_CHANGE_REQUIRED', 'Please change your password before continuing.');
  }
  return action.run(db, request, session, ctx);
}

// device.* requests (ESP32): no user session; the device key is checked first
// (authenticateDevice). Same tab rules as ACTIONS; a device action with writes
// runs under the lock. Unknown device.* actions load only Devices for the check.
export const DEVICE_TABS = Object.freeze({ read: ['Devices'], write: [], append: [] });

export const DEVICE_ACTIONS = Object.freeze({
  'device.submitScans': { run: submitScans,
    reads: 'Terms Classes Schedules Enrollments RfidCards Students Settings', writes: 'Devices ClassSessions Attendance ScanLog' },
  'device.heartbeat': { run: heartbeat, reads: 'Settings', writes: 'Devices' },
  'device.getRoster': { run: getRoster, reads: 'Devices RfidCards Students Settings' },
});

const findDeviceAction = (name) => (Object.prototype.hasOwnProperty.call(DEVICE_ACTIONS, name) ? DEVICE_ACTIONS[name] : null);

export function deviceTabsFor(name) {
  const action = findDeviceAction(name);
  if (!action) return DEVICE_TABS;
  const write = words(action.writes);
  return { read: [...new Set([...words(action.reads), ...write])], write, append: words(action.appends) };
}

export function runDeviceAction(db, request, ctx) {
  const device = authenticateDevice(db, request, ctx);
  const name = String(request.action || '');
  const action = findDeviceAction(name);
  if (!action) throw new AppError('UNKNOWN_ACTION', `Unknown action: ${name}`);
  return action.run(db, request, device, ctx);
}
