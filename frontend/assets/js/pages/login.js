// Login page logic (module). auth-forms.js (a classic script) handles the form
// UI and calls window.RFIDLogin, defined here, to talk to the server.
import { CONFIG } from '../config.js';
import { getSession, clearSession } from '../session.js';
import { signIn, changePassword, homeForRole } from '../auth.js';

const existing = getSession();
if (existing && !existing.must_change_password && homeForRole(existing.role)) {
  window.location.replace(homeForRole(existing.role));
} else {
  window.RFIDLogin = Object.freeze({
    configured: Boolean(CONFIG.API_URL),
    signIn,
    changePassword,
    goHome(session) {
      window.location.replace(homeForRole(session.role));
    },
    // Signed in but still has to change the default password (e.g. after a reload).
    pendingChange: existing && existing.must_change_password ? existing : null,
    cancelChange() {
      clearSession();
    },
  });
  document.dispatchEvent(new Event('rfid-login-ready'));

  if (!CONFIG.API_URL) {
    const box = document.getElementById('signInError');
    box.textContent = 'The server address (API_URL) is not set in config.js yet.';
    box.classList.remove('d-none');
  }
}
