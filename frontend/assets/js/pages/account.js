// "My account" for any portal: the page's <body data-role="..."> picks the role.
import { callApi } from '../api.js';
import { requireRole } from '../auth.js';
import {
  renderShell, escapeHtml, initials, formatDateTime, showFieldErrors, errorStateHtml, ROLE_LABELS,
} from '../ui.js';

const role = document.body.dataset.role;
const session = requireRole(role);
if (session) start();

function start() {
  const content = renderShell({ role, active: 'account', title: 'My Account', session });
  content.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">My account</h2>
        <p class="page-subtitle">Your sign-in details and password.</p>
      </div>
    </div>
    <div class="row g-3">
      <div class="col-lg-5"><div class="card h-100" id="accountCard"><div class="card-body"><div class="skeleton" style="height:180px"></div></div></div></div>
      <div class="col-lg-7">
        <div class="card h-100">
          <div class="card-header border-bottom"><h3 class="card-title-sm">Change password</h3></div>
          <form class="card-body" id="passwordForm" novalidate>
            <div class="alert d-none" data-role="form-result" role="status"></div>
            ${passwordField('old_password', 'Current password', 'current-password')}
            ${passwordField('new_password', 'New password', 'new-password', 'At least 8 characters, with both letters and numbers, and different from your current password.')}
            ${passwordField('confirm_password', 'Confirm new password', 'new-password')}
            <p class="small text-secondary">Changing your password signs you out on every other device. You stay signed in here.</p>
            <button type="submit" class="btn btn-primary" data-role="submit">Change password</button>
          </form>
        </div>
      </div>
    </div>`;

  loadAccount();
  setupPasswordForm(document.getElementById('passwordForm'));
}

function passwordField(name, label, autocomplete, hint = '') {
  return `
    <div class="mb-3">
      <label class="form-label" for="${name}">${escapeHtml(label)}</label>
      <input class="form-control" type="password" id="${name}" name="${name}" autocomplete="${autocomplete}" minlength="${name === 'old_password' ? 1 : 8}" maxlength="128" required${hint ? ` aria-describedby="${name}Hint"` : ''}>
      <div class="invalid-feedback" data-error-for="${name}"></div>
      ${hint ? `<div class="form-text" id="${name}Hint">${escapeHtml(hint)}</div>` : ''}
    </div>`;
}

async function loadAccount() {
  const card = document.getElementById('accountCard');
  try {
    const me = await callApi('auth.me');
    const row = (label, value) => `<dt class="col-5 fw-normal text-secondary">${escapeHtml(label)}</dt><dd class="col-7 text-break">${escapeHtml(value)}</dd>`;
    card.innerHTML = `
      <div class="card-body">
        <div class="d-flex align-items-center gap-3 mb-4">
          <span class="profile-avatar" aria-hidden="true">${escapeHtml(initials(me.display_name))}</span>
          <div class="min-w-0">
            <div class="fs-5 fw-semibold">${escapeHtml(me.display_name)}</div>
            <div class="text-secondary small">${escapeHtml(ROLE_LABELS[me.role] ?? me.role)}</div>
          </div>
        </div>
        <dl class="row small mb-0">
          ${row('Username', me.username)}
          ${row('Role', ROLE_LABELS[me.role] ?? me.role)}
          ${me.email ? row('Email', me.email) : ''}
          ${row('Last sign-in', me.last_login_at ? formatDateTime(me.last_login_at) : '—')}
        </dl>
      </div>`;
  } catch (error) {
    card.innerHTML = errorStateHtml(error.message);
    card.querySelector('[data-action="retry"]').addEventListener('click', loadAccount);
  }
}

function setupPasswordForm(form) {
  const submit = form.querySelector('[data-role="submit"]');
  const result = form.querySelector('[data-role="form-result"]');
  const show = (tone, message) => {
    result.className = `alert alert-${tone}`;
    result.textContent = message;
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    result.className = 'alert d-none';
    showFieldErrors(form, {});
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const values = Object.fromEntries(new FormData(form));
    if (values.new_password !== values.confirm_password) {
      showFieldErrors(form, { confirm_password: 'The new passwords do not match.' });
      return;
    }
    submit.disabled = true;
    try {
      const data = await callApi('auth.changePassword', { old_password: values.old_password, new_password: values.new_password });
      form.reset();
      const others = data.other_sessions_revoked;
      show('success', `Password changed.${others ? ` ${others} other session(s) were signed out.` : ''} You are still signed in here.`);
    } catch (error) {
      if (error.fields) showFieldErrors(form, error.fields);
      else show('danger', error.message);
    } finally {
      submit.disabled = false;
    }
  });
}
