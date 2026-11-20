import { CONFIG } from './config.js';
import { getSession, saveSession, endExpiredSession } from './session.js';

const LOGIN_URL = new URL('../../index.html', import.meta.url).href;
const TIMEOUT_MS = 45000; // Apps Script can take ~15 s when busy; never wait forever

export class ApiError extends Error {
  constructor(code, message, fields = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.fields = fields;
  }
}

export async function callApi(action, payload = {}) {
  const session = getSession();
  const request = { action, session_token: session?.token ?? null, ...payload };

  const response = await sendToServer(request);

  if (!response || response.ok !== true) {
    leaveIfSignedOut(response?.error?.code);
    throw new ApiError(
      response?.error?.code ?? 'UNKNOWN_ERROR',
      response?.error?.message ?? 'The request could not be completed.',
      response?.error?.fields ?? null,
    );
  }
  return response.data;
}

// Any page, any request: an ended session goes back to the login page.
function leaveIfSignedOut(code) {
  if (code === 'NOT_SIGNED_IN') {
    endExpiredSession(); // the login page says "Your session expired…"
  } else if (code === 'PASSWORD_CHANGE_REQUIRED') {
    const session = getSession();
    if (session) saveSession({ ...session, must_change_password: true }); // login page opens the change form
  } else {
    return;
  }
  if (window.location.href.split(/[?#]/)[0] !== LOGIN_URL) window.location.replace(LOGIN_URL);
}

async function sendToServer(request) {
  if (!CONFIG.API_URL) {
    throw new ApiError('API_NOT_CONFIGURED', 'The server address has not been configured yet.');
  }

  let httpResponse;
  try {
    httpResponse = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      throw new ApiError('TIMEOUT', 'The server took too long to answer. Please try again.');
    }
    throw new ApiError('NETWORK_ERROR', 'Cannot reach the server. Check your internet connection.');
  }

  if (!httpResponse.ok) {
    throw new ApiError('HTTP_ERROR', `The server responded with status ${httpResponse.status}.`);
  }

  try {
    return await httpResponse.json();
  } catch {
    throw new ApiError('BAD_RESPONSE', 'The server returned an invalid response.');
  }
}
