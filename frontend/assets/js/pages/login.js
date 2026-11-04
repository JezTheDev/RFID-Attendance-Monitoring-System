import { CONFIG } from '../config.js';
import { getSession } from '../session.js';
import { signInDemo, homeForRole } from '../auth.js';
import { escapeHtml } from '../ui.js';

const existing = getSession();
const existingHome = existing && homeForRole(existing.role);
if (existingHome) {
  window.location.replace(existingHome);
} else {
  renderSignIn();
}

function renderSignIn() {
  const area = document.getElementById('signInArea');

  if (CONFIG.MODE !== 'demo') {
    area.innerHTML = `
      <div class="alert alert-secondary mb-0">
        <i class="bi bi-hourglass-split me-1" aria-hidden="true"></i>
        Google Sign-In will be connected together with the backend (Phase 1).
      </div>`;
    return;
  }

  document.getElementById('demoBanner').innerHTML = `
    <div class="demo-banner" role="status"><i class="bi bi-info-circle me-1" aria-hidden="true"></i><strong>Demo mode:</strong> Google Sign-In is not connected yet. You will see fake test data only.</div>`;

  area.innerHTML = `
    <button type="button" class="btn btn-primary btn-lg w-100" id="demoAdminButton">
      <i class="bi bi-speedometer2 me-2" aria-hidden="true"></i>Continue as Demo Admin
    </button>
    <p class="small text-secondary mt-2 mb-0">The Instructor and Student portals will be added in the next sessions.</p>`;

  const button = document.getElementById('demoAdminButton');
  button.addEventListener('click', async () => {
    hideError();
    setBusy(button, true);
    try {
      const session = await signInDemo('admin');
      window.location.replace(homeForRole(session.role));
    } catch (error) {
      showError(error.message);
      setBusy(button, false);
    }
  });
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.innerHTML = busy
    ? '<span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Signing in…'
    : '<i class="bi bi-speedometer2 me-2" aria-hidden="true"></i>Continue as Demo Admin';
}

function showError(message) {
  const box = document.getElementById('signInError');
  box.innerHTML = `<i class="bi bi-exclamation-triangle me-1" aria-hidden="true"></i>${escapeHtml(message)}`;
  box.classList.remove('d-none');
}

function hideError() {
  document.getElementById('signInError').classList.add('d-none');
}
