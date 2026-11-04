import { callApi } from './api.js';
import { getSession, saveSession, clearSession } from './session.js';

const ROLE_HOME = Object.freeze({
  admin: 'admin/index.html',
});

export function appUrl(path = '') {
  return new URL(`../../${path}`, import.meta.url).href;
}

export function homeForRole(role) {
  return ROLE_HOME[role] ? appUrl(ROLE_HOME[role]) : null;
}

export async function signInDemo(role) {
  const data = await callApi('auth.demoSignIn', { role });
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
