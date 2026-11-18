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

// Username (instructors/admins) or student number (students) + password.
export async function signIn(username, password) {
  const data = await callApi('auth.login', { username, password });
  const session = {
    token: data.session_token,
    user_id: data.user_id,
    username: data.username,
    role: data.role,
    display_name: data.display_name,
    email: data.email,
    must_change_password: data.must_change_password === true,
    expires_at: data.expires_at,
  };
  if (!saveSession(session)) {
    throw new Error('Your browser blocked session storage, so you cannot stay signed in.');
  }
  return session;
}

export async function changePassword(oldPassword, newPassword) {
  await callApi('auth.changePassword', { old_password: oldPassword, new_password: newPassword });
  const session = getSession();
  if (session) saveSession({ ...session, must_change_password: false });
  return getSession();
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

// Navigation only: the server enforces roles and the forced password change.
export function requireRole(role) {
  const session = getSession();
  if (!session || session.must_change_password) {
    window.location.replace(appUrl('index.html'));
    return null;
  }
  if (session.role !== role) {
    window.location.replace(homeForRole(session.role) ?? appUrl('index.html'));
    return null;
  }
  return session;
}
