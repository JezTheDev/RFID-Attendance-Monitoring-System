// TEST TOOLING ONLY (never served by or imported from frontend/): answers the
// site's API calls with the REAL handlers (runAction) on an in-memory copy of
// backend/seed/seed-data.json, for tools/check_layout.mjs. FAKE data only.
import { readFileSync } from 'node:fs';
import { runAction } from '../../src/actions.js';
import { AppError } from '../../src/utils.js';
import { makeCtx } from './auth.js';

const SEED = JSON.parse(readFileSync(new URL('../../seed/seed-data.json', import.meta.url), 'utf8'));

// A Tuesday inside the seeded term and inside CLS-0004 (08:00-09:30, SCH-0005).
export const LAYOUT_NOW = '2026-11-03T08:30:00+08:00';
// One fixed FAKE password for the in-memory copy (like seedTestPasswords).
export const LAYOUT_PASSWORD = 'LayoutTest2026';
export const LAYOUT_USERS = Object.freeze({
  admin: 'admin.test',
  instructor: 'instructor01.test', // teaches CLS-0004, in session at LAYOUT_NOW
  student: '9999000007', // enrolled in CLS-0004
});

// Long strings (Review Focus 1) go into the in-memory copy only.
function addLongFixtures(db) {
  const student = db.Students.find((row) => row.student_id === 'STU-0007');
  student.first_name = 'Ma. Kristina Angelica';
  student.last_name = 'Dela Cruz-Villanueva';
  db.Subjects.find((row) => row.subject_id === 'SUB-0001').subject_title = 'Embedded Systems and Microcontroller Interfacing (TEST)';
}

export function createLayoutApi({ now = LAYOUT_NOW } = {}) {
  const db = structuredClone(SEED);
  addLongFixtures(db);
  const ctx = makeCtx({ startMs: Date.parse(now) });
  db.Users.forEach((user) => {
    user.password_hash = ctx.hash(LAYOUT_PASSWORD);
    user.must_change_password = 'FALSE';
  });

  // Same reply shape as Server.gs: { ok, data } or { ok:false, error }.
  function handle(body) {
    try {
      return { ok: true, data: runAction(db, body, ctx) };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return { ok: false, error: { code: error.code, message: error.message, fields: error.fields ?? null } };
    }
  }

  // The object the login page stores in sessionStorage['rfid.session'] (see auth.js signIn).
  function sessionFor(role) {
    const reply = handle({ action: 'auth.login', username: LAYOUT_USERS[role], password: LAYOUT_PASSWORD });
    if (!reply.ok) throw new Error(`layout login failed for ${role}: ${reply.error.code}`);
    const d = reply.data;
    return {
      token: d.session_token, user_id: d.user_id, username: d.username, role: d.role,
      display_name: d.display_name, email: d.email, must_change_password: d.must_change_password === true, expires_at: d.expires_at,
    };
  }

  return { handle, sessionFor, now, users: LAYOUT_USERS, password: LAYOUT_PASSWORD };
}
