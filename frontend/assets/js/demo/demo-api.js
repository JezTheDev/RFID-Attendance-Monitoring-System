import { loadDb, saveDb, resetDb } from './demo-store.js';
import { DemoError, setting } from './demo-utils.js';
import { getSession } from '../session.js';
import { getAdminDashboard } from './handlers/dashboard.js';
import {
  getStudentOptions, listStudents, getStudent, createStudent, updateStudent,
  setStudentStatus, assignCard, revokeCard, listUnregisteredUids,
} from './handlers/students.js';
import * as academic from './handlers/academic.js';
import * as instructors from './handlers/instructors.js';

const DEMO_LATENCY_MS = 300;

const READ = 'read';
const WRITE = 'write';

const handlers = {
  'auth.demoSignIn': { run: demoSignIn, mode: READ, public: true },
  'auth.logout': { run: () => ({}), mode: READ, public: true },
  'demo.reset': { run: () => { resetDb(); return {}; }, mode: READ, public: true },
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
};

export async function handleDemoRequest(request) {
  await new Promise((resolve) => setTimeout(resolve, DEMO_LATENCY_MS));
  const handler = handlers[request.action];
  if (!handler) return failure('UNKNOWN_ACTION', `Unknown action: ${request.action}`);

  const db = loadDb();
  const snapshot = handler.mode === WRITE ? structuredClone(db) : null;
  try {
    const session = handler.public ? null : authorize(request, handler.role);
    const data = handler.run(db, request, session);
    if (handler.mode === WRITE && !saveDb()) {
      throw new DemoError('STORAGE_ERROR', 'The demo could not save this change because browser storage is unavailable.');
    }
    return { ok: true, server_time: new Date().toISOString(), data };
  } catch (error) {
    if (snapshot) Object.keys(snapshot).forEach((table) => { db[table] = snapshot[table]; });
    if (error instanceof DemoError) return failure(error.code, error.message, error.fields);
    console.error(error);
    return failure('SERVER_ERROR', 'Unexpected error in demo data.');
  }
}

function failure(code, message, fields = null) {
  return { ok: false, server_time: new Date().toISOString(), error: { code, message, ...(fields ? { fields } : {}) } };
}

function authorize(request, role) {
  const session = getSession();
  if (!session || session.token !== request.session_token) {
    throw new DemoError('NOT_SIGNED_IN', 'Your session has ended. Please sign in again.');
  }
  if (session.role !== role) {
    throw new DemoError('FORBIDDEN', 'You do not have access to this information.');
  }
  return session;
}

function demoSignIn(db, { role }) {
  if (role !== 'admin') {
    throw new DemoError('ROLE_NOT_AVAILABLE', 'Only the Admin portal is available in this demo build.');
  }
  const user = db.Users.find((row) => row.role === 'admin' && row.account_status === 'active');
  if (!user) throw new DemoError('NOT_REGISTERED', 'No active admin account in the demo data.');
  return {
    session_token: `demo-${crypto.getRandomValues(new Uint32Array(2)).join('')}`,
    user_id: user.user_id,
    role: user.role,
    display_name: 'Demo Administrator',
    email: user.email,
    expires_at: new Date(Date.now() + Number(setting(db, 'session_token_hours', 8)) * 3600_000).toISOString(),
  };
}
