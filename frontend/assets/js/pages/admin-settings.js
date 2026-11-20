import { callApi } from '../api.js';
import { requireRole } from '../auth.js';
import {
  renderShell, escapeHtml, errorStateHtml, showFieldErrors,
} from '../ui.js';

// Page grouping and labels only; values, ranges and descriptions come from admin.getSettings.
const GROUPS = [
  {
    title: 'Attendance',
    keys: { duplicate_window_minutes: 'Duplicate tap window (minutes)', early_window_minutes: 'Early window (minutes)', accept_after_end_minutes: 'Accept after end (minutes)' },
  },
  {
    title: 'Devices',
    note: 'Devices pick up this change on their next roster check.',
    keys: { low_battery_voltage: 'Low battery voltage (V)', device_offline_after_minutes: 'Offline after (minutes)', heartbeat_interval_seconds: 'Heartbeat interval (seconds)' },
  },
  {
    title: 'Security',
    keys: { session_token_hours: 'Session length (hours)', max_login_attempts: 'Max sign-in attempts', lockout_minutes: 'Lockout (minutes)', temp_password_days: 'Temporary password (days)' },
  },
];
const LABELS = Object.assign({}, ...GROUPS.map((g) => g.keys));

const session = requireRole('admin');
if (session) start();

function start() {
  const content = renderShell({ role: 'admin', active: 'settings', title: 'Settings', session });
  content.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">Settings</h2>
        <p class="page-subtitle">System-wide rules for attendance, devices and sign-in. Changes apply right away.</p>
      </div>
    </div>
    <div id="settingsBody"><div class="skeleton mb-3" style="height:220px"></div><div class="skeleton" style="height:220px"></div></div>`;

  const body = document.getElementById('settingsBody');
  let items = [];
  const dirty = () => changedKeys(body, items).length > 0;
  window.addEventListener('beforeunload', (event) => {
    if (dirty()) event.preventDefault(); // the browser shows its "leave site?" prompt
  });

  const load = async (message = '') => {
    try {
      ({ items } = await callApi('admin.getSettings'));
      body.innerHTML = formHtml(items);
      const form = body.querySelector('form');
      if (message) showResult(form, 'success', message);
      wire(form);
    } catch (error) {
      body.innerHTML = `<div class="card">${errorStateHtml(error.message)}</div>`;
      body.querySelector('[data-action="retry"]').addEventListener('click', () => load());
    }
  };

  const wire = (form) => {
    const save = form.querySelector('[data-role="submit"]');
    const update = () => { save.disabled = !dirty(); };
    form.addEventListener('input', update);
    form.addEventListener('reset', () => setTimeout(() => { showFieldErrors(form, {}); update(); }));
    update();

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      showResult(form, '', '');
      const keys = changedKeys(form, items);
      if (!keys.length) return;
      const errors = {};
      const changes = {};
      keys.forEach((key) => {
        const item = items.find((i) => i.key === key);
        const text = form.elements.namedItem(key).value.trim();
        const problem = checkValue(item, text);
        if (problem) errors[key] = problem;
        else changes[key] = Number(text);
      });
      if (Object.keys(errors).length) {
        showFieldErrors(form, errors);
        showResult(form, 'danger', 'Nothing was saved. Fix the highlighted values.');
        return;
      }
      save.disabled = true;
      try {
        const result = await callApi('admin.updateSettings', { changes });
        const lines = result.changed.map((key) => `${LABELS[key] ?? key}: ${valueOf(items, key)} → ${valueOf(result.items, key)}`);
        await load(lines.length
          ? `Saved. ${lines.join('; ')}.${result.roster_version_bumped ? ' Devices pick up this change on their next roster check.' : ''}`
          : 'Nothing changed: the values were already saved.');
      } catch (error) {
        showFieldErrors(form, error.fields ?? {});
        showResult(form, 'danger', `Nothing was saved. ${error.message}`);
        save.disabled = false;
      }
    });
  };

  load();
}

const valueOf = (list, key) => list.find((i) => i.key === key)?.value ?? '';

function changedKeys(root, items) {
  return items.filter((item) => {
    const input = root.querySelector(`[name="${item.key}"]`);
    const text = input?.value.trim();
    // "3.5" over a stored "3.50" is not an edit.
    return input && text !== String(item.value) && !(text !== '' && Number(text) === Number(item.value));
  }).map((item) => item.key);
}

// Same rule as the backend (it stays the judge): whole or up-to-2-decimal number in range.
function checkValue(item, text) {
  const pattern = item.decimal ? /^\d+(\.\d{1,2})?$/ : /^\d+$/;
  const number = Number(text);
  if (!pattern.test(text) || number < item.min || number > item.max) return rangeText(item);
  return '';
}

function rangeText({ min, max, decimal }) {
  return decimal
    ? `Use a number from ${min.toFixed(2)} to ${max.toFixed(2)} (up to 2 decimal places).`
    : `Use a whole number from ${min} to ${max}.`;
}

function showResult(form, tone, message) {
  const box = form.querySelector('[data-role="form-result"]');
  box.className = tone ? `alert alert-${tone}` : 'alert d-none';
  box.textContent = message;
}

function fieldHtml(item, label) {
  const id = `s_${item.key}`;
  return `
    <div class="col-md-6 col-xl-4">
      <label class="form-label fw-semibold" for="${id}">${escapeHtml(label)}</label>
      <input class="form-control" type="text" inputmode="${item.decimal ? 'decimal' : 'numeric'}" id="${id}" name="${escapeHtml(item.key)}"
        value="${escapeHtml(item.value)}" autocomplete="off" aria-describedby="${id}_help">
      <div class="invalid-feedback" data-error-for="${escapeHtml(item.key)}"></div>
      <div class="form-text" id="${id}_help">${escapeHtml(item.description)}<br>Allowed: ${escapeHtml(item.decimal ? `${item.min.toFixed(2)}–${item.max.toFixed(2)}` : `${item.min}–${item.max}`)}</div>
    </div>`;
}

function formHtml(items) {
  const known = new Set(Object.keys(LABELS));
  const groups = [...GROUPS, { title: 'Other', keys: Object.fromEntries(items.filter((i) => !known.has(i.key)).map((i) => [i.key, i.key])) }];
  return `
    <form novalidate>
      <div class="alert d-none" data-role="form-result" role="status" aria-live="polite"></div>
      ${groups.map((group) => {
        const fields = Object.entries(group.keys).map(([key, label]) => {
          const item = items.find((i) => i.key === key);
          return item ? fieldHtml(item, label) : '';
        }).join('');
        if (!fields) return '';
        return `
          <section class="card mb-3">
            <div class="card-header border-bottom"><h3 class="card-title-sm">${escapeHtml(group.title)}</h3></div>
            <div class="card-body">
              ${group.note ? `<p class="small text-secondary"><i class="bi bi-info-circle me-1" aria-hidden="true"></i>${escapeHtml(group.note)}</p>` : ''}
              <div class="row g-3">${fields}</div>
            </div>
          </section>`;
      }).join('')}
      <div class="d-flex gap-2">
        <button type="submit" class="btn btn-primary" data-role="submit" disabled>Save changes</button>
        <button type="reset" class="btn btn-light border">Undo changes</button>
      </div>
    </form>`;
}
