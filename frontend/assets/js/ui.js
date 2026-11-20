import { CONFIG } from './config.js';
import { appUrl, signOut } from './auth.js';

const NAVIGATION = Object.freeze({
  admin: [
    {
      section: 'Overview',
      items: [
        { id: 'dashboard', label: 'Dashboard', icon: 'speedometer2', href: 'admin/index.html' },
        { id: 'attendance', label: 'Attendance', icon: 'clipboard-check', href: 'admin/attendance.html' },
      ],
    },
    {
      section: 'People',
      items: [
        { id: 'students', label: 'Students & Cards', icon: 'people', href: 'admin/students.html' },
        { id: 'instructors', label: 'Instructors', icon: 'person-video3', href: 'admin/instructors.html' },
        { id: 'admins', label: 'Administrators', icon: 'shield-lock', href: 'admin/admins.html' },
      ],
    },
    {
      section: 'Academic',
      items: [
        { id: 'classes', label: 'Classes & Schedules', icon: 'calendar-week', href: 'admin/classes.html' },
        { id: 'academic', label: 'Academic Setup', icon: 'building', href: 'admin/academic.html' },
      ],
    },
    {
      section: 'System',
      items: [
        { id: 'devices', label: 'Devices', icon: 'router', href: 'admin/devices.html' },
        { id: 'settings', label: 'Settings', icon: 'sliders', href: 'admin/settings.html' },
      ],
    },
    { section: 'Account', items: [{ id: 'account', label: 'My Account', icon: 'person-gear', href: 'admin/account.html' }] },
  ],
  instructor: [
    { section: 'Overview', items: [{ id: 'dashboard', label: 'Dashboard', icon: 'speedometer2', href: 'instructor/index.html' }] },
    {
      section: 'My Classes',
      items: [
        { id: 'attendance', label: 'Attendance', icon: 'clipboard-check', href: 'instructor/attendance.html' },
        { id: 'reports', label: 'Class Reports', icon: 'file-earmark-bar-graph', href: 'instructor/reports.html' },
      ],
    },
    { section: 'Account', items: [{ id: 'account', label: 'My Account', icon: 'person-gear', href: 'instructor/account.html' }] },
  ],
  student: [
    { section: 'Overview', items: [{ id: 'dashboard', label: 'My Attendance', icon: 'speedometer2', href: 'student/index.html' }] },
    { section: 'Records', items: [{ id: 'history', label: 'Attendance History', icon: 'clock-history', href: 'student/history.html' }] },
    { section: 'Account', items: [
      { id: 'profile', label: 'My Profile', icon: 'person-vcard', href: 'student/profile.html' },
      { id: 'account', label: 'My Account', icon: 'person-gear', href: 'student/account.html' },
    ] },
  ],
});

export const ROLE_LABELS = Object.freeze({ admin: 'Administrator', instructor: 'Instructor', student: 'Student' });

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function todayInManila() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

export function formatDateLong(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    .format(new Date(Date.UTC(year, month - 1, day)));
}

export function formatClockTime(hhmm) {
  const [hours, minutes] = hhmm.split(':').map(Number);
  const suffix = hours >= 12 ? 'PM' : 'AM';
  return `${((hours + 11) % 12) + 1}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

export function formatTimestamp(iso) {
  return new Intl.DateTimeFormat('en-PH', { timeZone: CONFIG.TIMEZONE, hour: 'numeric', minute: '2-digit' })
    .format(new Date(iso));
}

export function formatDateTime(iso) {
  return new Intl.DateTimeFormat('en-PH', { timeZone: CONFIG.TIMEZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    .format(new Date(iso));
}

export function formatRelative(iso) {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return 'just now';
  const units = [['day', 86400], ['hour', 3600], ['minute', 60]];
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return formatter.format(-Math.floor(seconds / size), unit);
  }
  return 'just now';
}

export function initials(name) {
  return String(name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('');
}

export function renderShell({ role, active, title, session }) {
  const app = document.getElementById('app');
  const navigation = NAVIGATION[role] ?? [];
  const activeGroup = navigation.find((group) => group.items.some((item) => item.id === active));
  const activeItem = activeGroup?.items.find((item) => item.id === active);
  const navHtml = navigation.map((group) => `
    <div class="sidebar-section">${escapeHtml(group.section)}</div>
    <nav class="sidebar-nav nav flex-column">
      ${group.items.map((item) => `
        <a class="nav-link${item.id === active ? ' active' : ''}" href="${appUrl(item.href)}" data-bs-title="${escapeHtml(item.label)}"${item.id === active ? ' aria-current="page"' : ''}>
          <i class="bi bi-${item.icon}" aria-hidden="true"></i><span>${escapeHtml(item.label)}</span>
        </a>`).join('')}
    </nav>`).join('');

  app.innerHTML = `
    <div class="app-layout">
      <aside class="app-sidebar offcanvas-lg offcanvas-start d-flex flex-column" tabindex="-1" id="appSidebar" aria-label="Main navigation">
        <div class="sidebar-brand">
          <div class="brand-mark" aria-hidden="true"><i class="bi bi-person-badge"></i></div>
          <div>
            <div class="brand-name">${escapeHtml(CONFIG.APP_NAME)}</div>
            <div class="brand-sub">${escapeHtml(ROLE_LABELS[role] ?? '')} portal</div>
          </div>
          <button type="button" class="btn-close btn-close-white ms-auto d-lg-none" data-bs-dismiss="offcanvas" data-bs-target="#appSidebar" aria-label="Close menu"></button>
        </div>
        ${navHtml}
        <div class="sidebar-footer">${escapeHtml(CONFIG.ORGANIZATION)}</div>
      </aside>
      <div class="app-main">
        <header class="app-topbar">
          <button class="btn btn-light border topbar-btn d-lg-none" type="button" data-bs-toggle="offcanvas" data-bs-target="#appSidebar" aria-controls="appSidebar" aria-label="Open menu">
            <i class="bi bi-list" aria-hidden="true"></i>
          </button>
          <button class="btn btn-light border topbar-btn sidebar-toggle d-none d-lg-inline-flex" type="button" data-action="toggle-sidebar" aria-controls="appSidebar" aria-expanded="true" aria-label="Collapse sidebar">
            <i class="bi bi-chevron-double-left" aria-hidden="true"></i>
          </button>
          <div class="topbar-heading min-w-0">
            <span class="topbar-icon" aria-hidden="true"><i class="bi bi-${activeItem?.icon ?? 'grid'}"></i></span>
            <div class="min-w-0">
              <div class="topbar-eyebrow">${escapeHtml(ROLE_LABELS[role] ?? '')}${activeGroup ? ` <i class="bi bi-chevron-right" aria-hidden="true"></i> ${escapeHtml(activeGroup.section)}` : ''}</div>
              <h1 class="topbar-title text-truncate">${escapeHtml(title)}</h1>
            </div>
          </div>
          <div class="topbar-clock ms-auto d-none d-md-flex" aria-label="Current date and time in Manila">
            <span class="live-dot" aria-hidden="true"></span>
            <i class="bi bi-calendar3" aria-hidden="true"></i><span data-role="today"></span>
            <span class="topbar-clock-sep" aria-hidden="true"></span>
            <i class="bi bi-clock" aria-hidden="true"></i><span data-role="clock"></span>
          </div>
          <div class="ms-auto ms-md-0 dropdown">
            <button class="user-chip dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false">
              <span class="user-avatar" aria-hidden="true">${escapeHtml(initials(session.display_name))}</span>
              <span class="d-none d-sm-inline text-start">
                <span class="d-block fw-semibold lh-sm">${escapeHtml(session.display_name)}</span>
                <span class="d-block small text-secondary lh-sm">${escapeHtml(ROLE_LABELS[session.role] ?? session.role)}</span>
              </span>
            </button>
            <ul class="dropdown-menu dropdown-menu-end shadow-sm">
              <li><span class="dropdown-item-text small text-secondary">${escapeHtml(session.username ?? session.email ?? '')}</span></li>
              <li><hr class="dropdown-divider"></li>
              <li><button class="dropdown-item" type="button" data-action="sign-out"><i class="bi bi-box-arrow-right me-2" aria-hidden="true"></i>Sign out</button></li>
            </ul>
          </div>
        </header>
        <main class="app-content page-enter" id="pageContent"></main>
      </div>
    </div>`;

  setupSidebar(app);
  startTopbarClock(app);

  app.querySelector('[data-action="sign-out"]').addEventListener('click', (event) => {
    event.currentTarget.disabled = true;
    signOut();
  });

  // Entrance animations run only on the first load of the page,
  // not every time the content is refreshed.
  const content = document.getElementById('pageContent');
  setTimeout(() => content.classList.remove('page-enter'), 1600);
  return content;
}

/* ---------- Topbar clock (Manila time) ---------- */
function startTopbarClock(app) {
  const today = app.querySelector('[data-role="today"]');
  const clock = app.querySelector('[data-role="clock"]');
  if (!today || !clock) return;
  const dateFormat = new Intl.DateTimeFormat('en-PH', { timeZone: CONFIG.TIMEZONE, weekday: 'short', month: 'short', day: 'numeric' });
  const timeFormat = new Intl.DateTimeFormat('en-PH', { timeZone: CONFIG.TIMEZONE, hour: 'numeric', minute: '2-digit' });
  const tick = () => {
    const now = new Date();
    today.textContent = dateFormat.format(now);
    clock.textContent = timeFormat.format(now);
  };
  tick();
  setInterval(tick, 15000);
}

/* ---------- Sidebar collapse (desktop) & off-canvas (mobile) ---------- */
const SIDEBAR_KEY = 'rfid.sidebarCollapsed';
const DESKTOP_QUERY = window.matchMedia('(min-width: 992px)');

function readSidebarCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {
    return false;
  }
}

function saveSidebarCollapsed(collapsed) {
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
  } catch {
    /* storage unavailable: the choice just won't be remembered */
  }
}

function setupSidebar(app) {
  const layout = app.querySelector('.app-layout');
  const sidebar = app.querySelector('#appSidebar');
  const toggle = app.querySelector('[data-action="toggle-sidebar"]');
  const links = [...sidebar.querySelectorAll('.sidebar-nav .nav-link')];

  // Labels appear as tooltips only while the desktop sidebar is collapsed
  const tooltips = links.map((link) => new window.bootstrap.Tooltip(link, {
    placement: 'right',
    trigger: 'hover focus',
    customClass: 'sidebar-tooltip',
  }));

  const syncTooltips = () => {
    const on = layout.classList.contains('sidebar-collapsed') && DESKTOP_QUERY.matches;
    tooltips.forEach((tip) => {
      if (on) {
        tip.enable();
      } else {
        tip.hide();
        tip.disable();
      }
    });
  };

  const apply = (collapsed) => {
    layout.classList.toggle('sidebar-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    toggle.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    syncTooltips();
  };

  apply(readSidebarCollapsed());

  toggle.addEventListener('click', () => {
    const next = !layout.classList.contains('sidebar-collapsed');
    apply(next);
    saveSidebarCollapsed(next);
  });

  DESKTOP_QUERY.addEventListener('change', syncTooltips);

  // Mobile: close the menu as soon as a link is picked
  links.forEach((link) => link.addEventListener('click', () => {
    window.bootstrap.Offcanvas.getInstance(sidebar)?.hide();
  }));
}

function toastContainer() {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container position-fixed bottom-0 end-0 p-3';
    document.body.append(container);
  }
  return container;
}

export function showToast(message, tone = 'success') {
  const icons = { success: 'check-circle', danger: 'exclamation-triangle', warning: 'exclamation-circle', info: 'info-circle' };
  const toast = document.createElement('div');
  toast.className = `toast align-items-center text-bg-${tone} border-0`;
  toast.setAttribute('role', tone === 'danger' ? 'alert' : 'status');
  toast.setAttribute('aria-live', tone === 'danger' ? 'assertive' : 'polite');
  toast.innerHTML = `
    <div class="d-flex">
      <div class="toast-body"><i class="bi bi-${icons[tone] ?? 'info-circle'} me-2" aria-hidden="true"></i>${escapeHtml(message)}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
    </div>`;
  toastContainer().append(toast);
  toast.addEventListener('hidden.bs.toast', () => toast.remove());
  new window.bootstrap.Toast(toast, { delay: 4500 }).show();
}

export function showFieldErrors(form, fields) {
  form.querySelectorAll('.is-invalid').forEach((input) => input.classList.remove('is-invalid'));
  form.querySelectorAll('[data-error-for]').forEach((box) => { box.textContent = ''; });
  let first = null;
  Object.entries(fields ?? {}).forEach(([name, message]) => {
    const input = form.elements.namedItem(name);
    const box = form.querySelector(`[data-error-for="${name}"]`);
    if (input?.classList) {
      input.classList.add('is-invalid');
      first ??= input;
    }
    if (box) box.textContent = message;
  });
  first?.focus();
}

export function openFormModal({ title, bodyHtml, submitLabel = 'Save', submitTone = 'primary', size = '', onSubmit }) {
  return new Promise((resolve) => {
    const element = document.createElement('div');
    element.className = 'modal fade';
    element.tabIndex = -1;
    element.setAttribute('aria-hidden', 'true');
    element.innerHTML = `
      <div class="modal-dialog modal-dialog-scrollable ${size}">
        <form class="modal-content" novalidate>
          <div class="modal-header">
            <h2 class="modal-title fs-5">${escapeHtml(title)}</h2>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body">
            <div class="alert alert-danger d-none" data-role="form-error" role="alert"></div>
            ${bodyHtml}
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-light border" data-bs-dismiss="modal">Cancel</button>
            <button type="submit" class="btn btn-${submitTone}" data-role="submit">${escapeHtml(submitLabel)}</button>
          </div>
        </form>
      </div>`;
    document.body.append(element);

    const modal = new window.bootstrap.Modal(element);
    const form = element.querySelector('form');
    const submit = form.querySelector('[data-role="submit"]');
    const errorBox = form.querySelector('[data-role="form-error"]');
    let result = null;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      errorBox.classList.add('d-none');
      showFieldErrors(form, {});
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }
      submit.disabled = true;
      submit.innerHTML = `<span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>${escapeHtml(submitLabel)}`;
      try {
        result = await onSubmit(Object.fromEntries(new FormData(form)), form);
        modal.hide();
      } catch (error) {
        if (error.fields) showFieldErrors(form, error.fields);
        errorBox.textContent = error.message;
        errorBox.classList.remove('d-none');
        submit.disabled = false;
        submit.textContent = submitLabel;
        if (!error.fields) submit.focus();
      }
    });

    element.addEventListener('shown.bs.modal', () => form.querySelector('input:not([type=hidden]), select, textarea')?.focus());
    element.addEventListener('hidden.bs.modal', () => {
      modal.dispose();
      element.remove();
      resolve(result);
    });
    modal.show();
  });
}

export function confirmAction({ title, message, confirmLabel = 'Confirm', tone = 'primary', reasonLabel = '', run = null }) {
  const reasonField = reasonLabel
    ? `<label class="form-label mt-3" for="confirmReason">${escapeHtml(reasonLabel)}</label>
       <textarea class="form-control" id="confirmReason" name="reason" rows="2" maxlength="200" required></textarea>
       <div class="invalid-feedback" data-error-for="reason"></div>`
    : '';
  return openFormModal({
    title,
    bodyHtml: `<p class="mb-0">${escapeHtml(message)}</p>${reasonField}`,
    submitLabel: confirmLabel,
    submitTone: tone,
    onSubmit: async (values) => ({ confirmed: true, reason: values.reason ?? '', data: run ? await run(values) : null }),
  }).then((result) => result ?? { confirmed: false });
}

// Shows a new account's temporary password ONCE (see showSecretOnce).
export function showTempPassword({ username, temp_password: tempPassword, temp_password_expires_at: expiresAt }) {
  if (!tempPassword) return Promise.resolve();
  return showSecretOnce({
    title: 'Temporary password',
    secret: tempPassword,
    label: 'Temporary password',
    headHtml: username ? `<p class="mb-2">Username: <span class="font-monospace fw-semibold">${escapeHtml(username)}</span></p>` : '',
    noteHtml: `Give this to the user. It will not be shown again. ${expiresAt ? `Expires ${escapeHtml(formatDateTime(expiresAt))}.` : 'Expires in 7 days.'}
              The dash is optional when they type it. Then they choose their own password.`,
  });
}

// A secret (temporary password, device key) shown ONCE, with Copy. It lives only
// in this modal's DOM (removed on close): never in storage, the URL, or a toast.
export function showSecretOnce({ title, secret, label, headHtml = '', noteHtml, long = false }) {
  return new Promise((resolve) => {
    const element = document.createElement('div');
    element.className = 'modal fade';
    element.tabIndex = -1;
    element.setAttribute('aria-hidden', 'true');
    element.setAttribute('data-bs-backdrop', 'static');
    element.innerHTML = `
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h2 class="modal-title fs-5">${escapeHtml(title)}</h2>
          </div>
          <div class="modal-body">
            ${headHtml}
            <div class="d-flex align-items-center gap-2 border rounded p-3 bg-body-tertiary">
              <output class="font-monospace ${long ? 'small' : 'fs-2'} fw-bold flex-grow-1 text-break user-select-all" style="letter-spacing:${long ? '0' : '0.08em'}" aria-label="${escapeHtml(label)}">${escapeHtml(secret)}</output>
              <button type="button" class="btn btn-outline-primary" data-role="copy"><i class="bi bi-clipboard me-1" aria-hidden="true"></i>Copy</button>
            </div>
            <div class="alert alert-warning small mt-3 mb-0" role="note">
              ${noteHtml}
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-primary" data-bs-dismiss="modal">Done</button>
          </div>
        </div>
      </div>`;
    document.body.append(element);
    const modal = new window.bootstrap.Modal(element);
    const copy = element.querySelector('[data-role="copy"]');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(secret);
        copy.innerHTML = '<i class="bi bi-check2 me-1" aria-hidden="true"></i>Copied';
      } catch {
        window.getSelection()?.selectAllChildren(element.querySelector('output')); // let the admin press Ctrl+C
      }
    });
    element.addEventListener('shown.bs.modal', () => copy.focus());
    element.addEventListener('hidden.bs.modal', () => {
      modal.dispose();
      element.remove();
      resolve();
    });
    modal.show();
  });
}

export function stateHtml({ icon, title, message = '', action = '' }) {
  return `
    <div class="state-box">
      <i class="bi bi-${icon}" aria-hidden="true"></i>
      <div class="fw-semibold text-body">${escapeHtml(title)}</div>
      ${message ? `<div class="small mt-1">${escapeHtml(message)}</div>` : ''}
      ${action}
    </div>`;
}

export function errorStateHtml(message) {
  return stateHtml({
    icon: 'exclamation-triangle text-danger',
    title: 'Something went wrong',
    message,
    action: '<button type="button" class="btn btn-outline-primary btn-sm mt-3" data-action="retry"><i class="bi bi-arrow-clockwise me-1" aria-hidden="true"></i>Try again</button>',
  });
}