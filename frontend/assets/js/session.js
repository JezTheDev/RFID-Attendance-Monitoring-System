const SESSION_KEY = 'rfid.session';

export function getSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (!session?.token || !session?.role) return null;
    if (session.expires_at && Date.parse(session.expires_at) <= Date.now()) {
      endExpiredSession();
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export function saveSession(session) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

// Clears the session and leaves a note for the login page to show once.
const EXPIRED_KEY = 'rfid.sessionExpired';

export function endExpiredSession() {
  clearSession();
  try {
    sessionStorage.setItem(EXPIRED_KEY, '1');
  } catch {
    /* storage unavailable: the login page just won't show the note */
  }
}

// True once after endExpiredSession(), then forgotten.
export function takeExpiredNotice() {
  try {
    const expired = sessionStorage.getItem(EXPIRED_KEY) === '1';
    sessionStorage.removeItem(EXPIRED_KEY);
    return expired;
  } catch {
    return false;
  }
}

export function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable: nothing to clear */
  }
}
