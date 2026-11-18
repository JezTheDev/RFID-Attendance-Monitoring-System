import { callApi } from './api.js';
import { getSession, saveSession, clearSession } from './session.js';

const ROLE_HOME = Object.freeze({
  admin: 'admin/index.html',
  instructor: 'instructor/index.html',
  student: 'student/index.html',
});

export function appUrl(path = '') {
  return new URL(`../../${path}`, import.meta.url).href;
}

export function homeForRole(role) {
  return ROLE_HOME[role] ? appUrl(ROLE_HOME[role]) : null;
}

// Test account on the server (only works while TEST_LOGIN / ALLOW_TEST_LOGIN
// are turned on). Temporary: replaced by username/password login next.
export function signInTest(role) {
  return startSession('auth.testSignIn', { role });
}

// Exchange the Google ID token for our own session token.
export function signInWithGoogle(idToken) {
  return startSession('auth.google', { id_token: idToken });
}

async function startSession(action, payload) {
  const data = await callApi(action, payload);
  const session = {
    token: data.session_token,
    user_id: data.user_id,
    role: data.role,
    display_name: data.display_name,
    email: data.email,
    expires_at: data.expires_at,
  };
  if (!saveSession(session)) {
    throw new Error('Your browser blocked session storage, so you cannot stay signed in.');
  }
  return session;
}

export async function signOut() {
  try {
    await callApi('auth.logout');
  } catch {
    /* the local session is cleared anyway; the server token expires on its own */
  }
  clearSession();
  window.location.replace(appUrl('index.html'));
}

export function requireRole(role) {
  const session = getSession();
  if (!session) {
    window.location.replace(appUrl('index.html'));
    return null;
  }
  if (session.role !== role) {
    window.location.replace(homeForRole(session.role) ?? appUrl('index.html'));
    return null;
  }
  return session;
}
