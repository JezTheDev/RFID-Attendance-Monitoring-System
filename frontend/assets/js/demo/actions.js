// Every portal action (admin, instructor, student) and which role may call it.
// Shared by the in-browser demo (demo-api.js) and the real Apps Script
// backend (backend/apps-script, built by tools/build_apps_script.mjs),
// so both behave the same way.
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

export const READ = 'read';
export const WRITE = 'write';

export const ACTIONS = Object.freeze({
  'admin.getDashboard': { run: getAdminDashboard, mode: READ, role: 'admin' },
  'admin.getStudentOptions': { run: getStudentOptions, mode: READ, role: 'admin' },
  'admin.listStudents': { run: listStudents, mode: READ, role: 'admin' },
  'admin.getStudent': { run: getStudent, mode: READ, role: 'admin' },
  'admin.listUnregisteredUids': { run: listUnregisteredUids, mode: READ, role: 'admin' },
  'admin.createStudent': { run: createStudent, mode: WRITE, role: 'admin' },
  'admin.updateStudent': { run: updateStudent, mode: WRITE, role: 'admin' },
  'admin.setStudentStatus': { run: setStudentStatus, mode: WRITE, role: 'admin' },
  'admin.assignCard': { run: assignCard, mode: WRITE, role: 'admin' },
  'admin.revokeCard': { run: revokeCard, mode: WRITE, role: 'admin' },
  'admin.listTerms': { run: academic.listTerms, mode: READ, role: 'admin' },
  'admin.createTerm': { run: academic.createTerm, mode: WRITE, role: 'admin' },
  'admin.updateTerm': { run: academic.updateTerm, mode: WRITE, role: 'admin' },
  'admin.setActiveTerm': { run: academic.setActiveTerm, mode: WRITE, role: 'admin' },
  'admin.listPrograms': { run: academic.listPrograms, mode: READ, role: 'admin' },
  'admin.createProgram': { run: academic.createProgram, mode: WRITE, role: 'admin' },
  'admin.updateProgram': { run: academic.updateProgram, mode: WRITE, role: 'admin' },
  'admin.setProgramStatus': { run: academic.setProgramStatus, mode: WRITE, role: 'admin' },
  'admin.listSections': { run: academic.listSections, mode: READ, role: 'admin' },
  'admin.createSection': { run: academic.createSection, mode: WRITE, role: 'admin' },
  'admin.updateSection': { run: academic.updateSection, mode: WRITE, role: 'admin' },
  'admin.setSectionStatus': { run: academic.setSectionStatus, mode: WRITE, role: 'admin' },
  'admin.listSubjects': { run: academic.listSubjects, mode: READ, role: 'admin' },
  'admin.createSubject': { run: academic.createSubject, mode: WRITE, role: 'admin' },
  'admin.updateSubject': { run: academic.updateSubject, mode: WRITE, role: 'admin' },
  'admin.setSubjectStatus': { run: academic.setSubjectStatus, mode: WRITE, role: 'admin' },
  'admin.listRooms': { run: academic.listRooms, mode: READ, role: 'admin' },
  'admin.createRoom': { run: academic.createRoom, mode: WRITE, role: 'admin' },
  'admin.updateRoom': { run: academic.updateRoom, mode: WRITE, role: 'admin' },
  'admin.setRoomStatus': { run: academic.setRoomStatus, mode: WRITE, role: 'admin' },
  'admin.listInstructors': { run: instructors.listInstructors, mode: READ, role: 'admin' },
  'admin.createInstructor': { run: instructors.createInstructor, mode: WRITE, role: 'admin' },
  'admin.updateInstructor': { run: instructors.updateInstructor, mode: WRITE, role: 'admin' },
  'admin.setInstructorStatus': { run: instructors.setInstructorStatus, mode: WRITE, role: 'admin' },
  'admin.listAdmins': { run: admins.listAdmins, mode: READ, role: 'admin' },
  'admin.createAdmin': { run: admins.createAdmin, mode: WRITE, role: 'admin' },
  'admin.updateAdmin': { run: admins.updateAdmin, mode: WRITE, role: 'admin' },
  'admin.setAdminStatus': { run: admins.setAdminStatus, mode: WRITE, role: 'admin' },
  'admin.getClassOptions': { run: classes.getClassOptions, mode: READ, role: 'admin' },
  'admin.listClasses': { run: classes.listClasses, mode: READ, role: 'admin' },
  'admin.getClass': { run: classes.getClass, mode: READ, role: 'admin' },
  'admin.createClass': { run: classes.createClass, mode: WRITE, role: 'admin' },
  'admin.updateClass': { run: classes.updateClass, mode: WRITE, role: 'admin' },
  'admin.setClassStatus': { run: classes.setClassStatus, mode: WRITE, role: 'admin' },
  'admin.addSchedule': { run: classes.addSchedule, mode: WRITE, role: 'admin' },
  'admin.removeSchedule': { run: classes.removeSchedule, mode: WRITE, role: 'admin' },
  'admin.enrollStudents': { run: classes.enrollStudents, mode: WRITE, role: 'admin' },
  'admin.dropEnrollment': { run: classes.dropEnrollment, mode: WRITE, role: 'admin' },
  'instructor.getDashboard': { run: portal.instructorDashboard, mode: READ, role: 'instructor' },
  'instructor.listSessions': { run: portal.instructorListSessions, mode: READ, role: 'instructor' },
  'instructor.getSession': { run: portal.instructorGetSession, mode: READ, role: 'instructor' },
  'instructor.correctAttendance': { run: portal.instructorCorrectAttendance, mode: WRITE, role: 'instructor' },
  'instructor.getClassReport': { run: portal.instructorClassReport, mode: READ, role: 'instructor' },
  'instructor.getClassRoster': { run: portal.instructorClassRoster, mode: READ, role: 'instructor' },
  'instructor.getStudentHistory': { run: portal.instructorStudentHistory, mode: READ, role: 'instructor' },
  'student.getOverview': { run: portal.studentOverview, mode: READ, role: 'student' },
  'student.getHistory': { run: portal.studentHistory, mode: READ, role: 'student' },
  'student.getProfile': { run: portal.studentGetProfile, mode: READ, role: 'student' },
});
