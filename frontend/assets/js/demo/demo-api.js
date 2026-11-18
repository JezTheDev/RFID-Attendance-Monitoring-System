import { loadDb, saveDb, resetDb } from './demo-store.js';
import { DemoError, setting } from './demo-utils.js';
import { getSession } from '../session.js';
import { ACTIONS, READ, WRITE } from './actions.js';

const DEMO_LATENCY_MS = 300;

const handlers = {
  'auth.demoSignIn': { run: demoSignIn, mode: READ, public: true },
  'auth.logout': { run: () => ({}), mode: READ, public: true },
  'demo.reset': { run: () => { resetDb(); return {}; }, mode: READ, public: true },
  ...ACTIONS,
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

// Which fake account each demo button signs in as
const DEMO_ACCOUNTS = Object.freeze({
  admin: { user_id: 'USR-0001', name: () => 'Demo Administrator' },
  instructor: { user_id: 'USR-0002', name: (db, linkedId) => personName(db.Instructors.find((row) => row.instructor_id === linkedId)) },
  student: { user_id: 'USR-0005', name: (db, linkedId) => personName(db.Students.find((row) => row.student_id === linkedId)) },
});

function personName(person) {
  return person ? `${person.first_name} ${person.last_name}` : 'Demo user';
}

function demoSignIn(db, { role }) {
  const account = DEMO_ACCOUNTS[role];
  if (!account) throw new DemoError('ROLE_NOT_AVAILABLE', 'This portal is not available in the demo.');
  const user = db.Users.find((row) => row.user_id === account.user_id && row.role === role && row.account_status === 'active')
    ?? db.Users.find((row) => row.role === role && row.account_status === 'active');
  if (!user) throw new DemoError('NOT_REGISTERED', `No active ${role} account in the demo data.`);
  return {
    session_token: `demo-${crypto.getRandomValues(new Uint32Array(2)).join('')}`,
    user_id: user.user_id,
    role: user.role,
    display_name: account.name(db, user.linked_id),
    email: user.email,
    expires_at: new Date(Date.now() + Number(setting(db, 'session_token_hours', 8)) * 3600000).toISOString(),
  };
}
