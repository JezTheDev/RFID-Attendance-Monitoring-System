import { CONFIG } from '../config.js';
import { getSession } from '../session.js';
import { signInTest, signInWithGoogle, homeForRole } from '../auth.js';
import { escapeHtml } from '../ui.js';

const ROLES = [
  { role: 'admin', label: 'Admin', icon: 'speedometer2', primary: true },
  { role: 'instructor', label: 'Instructor', icon: 'mortarboard' },
  { role: 'student', label: 'Student', icon: 'person' },
];

const GOOGLE_SCRIPT = 'https://accounts.google.com/gsi/client';

const existing = getSession();
const existingHome = existing && homeForRole(existing.role);
if (existingHome) {
  window.location.replace(existingHome);
} else {
  renderSignIn();
}

/* ---------- Sign-in options (temporary until username/password login) ---------- */
function renderSignIn() {
  const area = document.getElementById('signInArea');

  if (!CONFIG.API_URL) {
    area.innerHTML = '<div class="alert alert-warning mb-0 small">The server address (API_URL) is not set in config.js yet.</div>';
    return;
  }

  const parts = [];
  if (CONFIG.GOOGLE_CLIENT_ID) {
    parts.push('<div id="googleButton" class="d-flex justify-content-center" style="min-height:44px"></div>');
  }
  if (CONFIG.TEST_LOGIN) {
    parts.push(`
      <div class="alert alert-warning small py-2 mb-0"><i class="bi bi-cone-striped me-1" aria-hidden="true"></i>Test sign-in is on. Turn it off before real use.</div>
      ${roleButtonsHtml('Test as')}`);
  }
  if (!parts.length) {
    area.innerHTML = '<div class="alert alert-warning mb-0 small">No sign-in method is set. Add GOOGLE_CLIENT_ID (or turn on TEST_LOGIN for testing) in config.js.</div>';
    return;
  }
  area.innerHTML = parts.join('');
  if (CONFIG.TEST_LOGIN) wireRoleButtons(area, 'Test as');
  if (CONFIG.GOOGLE_CLIENT_ID) loadGoogleButton(document.getElementById('googleButton'));
}

function loadGoogleButton(container) {
  const script = document.createElement('script');
  script.src = GOOGLE_SCRIPT;
  script.async = true;
  script.onload = () => {
    window.google.accounts.id.initialize({
      client_id: CONFIG.GOOGLE_CLIENT_ID,
      callback: async ({ credential }) => {
        hideError();
        window.showAuthSplash?.();
        try {
          const session = await signInWithGoogle(credential);
          window.location.replace(homeForRole(session.role));
        } catch (error) {
          window.hideAuthSplash?.();
          showError(error.message);
        }
      },
    });
    window.google.accounts.id.renderButton(container, {
      theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', width: Math.min(container.clientWidth || 360, 400),
    });
  };
  script.onerror = () => showError('Could not load Google Sign-In. Check your internet connection.');
  document.head.append(script);
}

/* ---------- Shared: Admin / Instructor / Student buttons ---------- */
function roleButtonsHtml(prefix) {
  return `
    <div class="demo-roles">
      ${ROLES.map((item) => `
        <button type="button" class="btn ${item.primary ? 'btn-primary btn-lg' : 'btn-outline-primary'} w-100" data-demo-role="${item.role}">
          ${buttonLabel(item, prefix)}
        </button>`).join('')}
    </div>`;
}

function buttonLabel(item, prefix) {
  const text = item.primary ? `${prefix} ${item.label}` : item.label;
  return `<i class="bi bi-${item.icon} me-2" aria-hidden="true"></i>${escapeHtml(text)}`;
}

function wireRoleButtons(area, prefix) {
  area.querySelectorAll('[data-demo-role]').forEach((button) => {
    button.addEventListener('click', async () => {
      const item = ROLES.find((row) => row.role === button.dataset.demoRole);
      hideError();
      area.querySelectorAll('[data-demo-role]').forEach((b) => { b.disabled = true; });
      button.innerHTML = '<span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Signing in…';
      try {
        const session = await signInTest(item.role);
        window.location.replace(homeForRole(session.role));
      } catch (error) {
        showError(error.message);
        button.innerHTML = buttonLabel(item, prefix);
        area.querySelectorAll('[data-demo-role]').forEach((b) => { b.disabled = false; });
      }
    });
  });
}

function showError(message) {
  const box = document.getElementById('signInError');
  box.innerHTML = `<i class="bi bi-exclamation-triangle me-1" aria-hidden="true"></i>${escapeHtml(message)}`;
  box.classList.remove('d-none');
}

function hideError() {
  document.getElementById('signInError').classList.add('d-none');
}
