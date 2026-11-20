import { callApi } from '../api.js';
import {
  escapeHtml, stateHtml, errorStateHtml, openFormModal, confirmAction, showToast, showTempPassword, formatDateTime,
} from '../ui.js';

// Sign-in state of an account summary (user_id, locked, locked_until, must_change_password).
export function accountStateHtml(account) {
  if (!account?.user_id) return '<span class="badge text-bg-danger">No sign-in account</span>';
  if (account.locked) return `<span class="badge text-bg-danger">Locked until ${escapeHtml(formatDateTime(account.locked_until))}</span>`;
  if (account.must_change_password) return '<span class="badge rounded-pill bg-warning-subtle text-warning-emphasis border border-warning-subtle">Must change password</span>';
  return '<span class="small text-secondary">Password set</span>';
}

// Confirm → admin.resetPassword → the new temporary password, shown once. Errors stay in the dialog.
export async function resetPasswordFlow({ user_id: userId, username }, name, done) {
  const { confirmed, data } = await confirmAction({
    title: `Reset the password of ${name}?`,
    message: 'Their current password stops working and they are signed out everywhere. You get a new temporary password to give them; they must change it at the next sign-in.',
    confirmLabel: 'Reset password',
    tone: 'danger',
    run: () => callApi('admin.resetPassword', { user_id: userId }),
  });
  if (!confirmed) return;
  await showTempPassword({ ...data, username });
  await done();
}

// Confirm → admin.unlockUser.
export async function unlockFlow({ user_id: userId }, name, done) {
  const { confirmed } = await confirmAction({
    title: `Unlock ${name}?`,
    message: 'They can sign in again right away. The failed sign-in count goes back to zero.',
    confirmLabel: 'Unlock',
    run: () => callApi('admin.unlockUser', { user_id: userId }),
  });
  if (!confirmed) return;
  showToast(`${name} unlocked.`);
  await done();
}

const HIDE_BELOW = { sm: 'd-none d-sm-table-cell', md: 'd-none d-md-table-cell', lg: 'd-none d-lg-table-cell' };

export function statusBadge(status) {
  return status === 'active'
    ? '<span class="badge rounded-pill bg-success-subtle text-success-emphasis border border-success-subtle">Active</span>'
    : '<span class="badge rounded-pill bg-secondary-subtle text-secondary-emphasis border border-secondary-subtle">Inactive</span>';
}

function fieldHtml(field) {
  const id = `rm_${field.name}`;
  const value = escapeHtml(field.value ?? '');
  const common = `id="${id}" name="${field.name}"${field.required ? ' required' : ''}`;
  let input;
  if (field.type === 'select') {
    input = `<select class="form-select" ${common}>
      <option value="">${escapeHtml(field.placeholder ?? 'Choose…')}</option>
      ${field.options.map((option) => `<option value="${escapeHtml(option.value)}"${String(option.value) === String(field.value ?? '') ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
    </select>`;
  } else {
    const attributes = [
      field.maxlength ? `maxlength="${field.maxlength}"` : '',
      field.min !== undefined ? `min="${field.min}"` : '',
      field.max !== undefined ? `max="${field.max}"` : '',
      field.inputmode ? `inputmode="${field.inputmode}"` : '',
      field.placeholder ? `placeholder="${escapeHtml(field.placeholder)}"` : '',
    ].filter(Boolean).join(' ');
    input = `<input type="${field.type ?? 'text'}" class="form-control${field.uppercase ? ' text-uppercase' : ''}" ${common} ${attributes} autocomplete="off" value="${value}">`;
  }
  return `
    <div class="${field.half ? 'col-sm-6' : 'col-12'}">
      <label class="form-label" for="${id}">${escapeHtml(field.label)}${field.required ? '' : ' <span class="text-secondary">(optional)</span>'}</label>
      ${input}
      <div class="invalid-feedback" data-error-for="${field.name}"></div>
      ${field.help ? `<div class="form-text">${escapeHtml(field.help)}</div>` : ''}
    </div>`;
}

export function mountResourceManager(container, config) {
  const state = { search: '', status: 'active', data: null, request: 0 };
  const hasStatus = Boolean(config.statusAction);

  container.innerHTML = `
    <div class="d-flex flex-wrap gap-2 align-items-end justify-content-between mb-3">
      <div class="d-flex flex-wrap gap-2 flex-grow-1">
        <div style="min-width:220px;flex:1 1 260px;max-width:420px">
          <label class="visually-hidden" for="${config.key}Search">Search ${escapeHtml(config.entityPlural)}</label>
          <input type="search" class="form-control" id="${config.key}Search" placeholder="Search ${escapeHtml(config.entityPlural.toLowerCase())}" autocomplete="off">
        </div>
        ${hasStatus ? `
          <div>
            <label class="visually-hidden" for="${config.key}Status">Status</label>
            <select class="form-select" id="${config.key}Status">
              <option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option>
            </select>
          </div>` : ''}
      </div>
      <button type="button" class="btn btn-primary" data-rm="add" disabled>
        <i class="bi bi-plus-lg me-1" aria-hidden="true"></i>Add ${escapeHtml(config.entity.toLowerCase())}
      </button>
    </div>
    ${config.description ? `<p class="small text-secondary mb-3">${escapeHtml(config.description)}</p>` : ''}
    <div class="card" data-rm="list"></div>`;

  const listBox = container.querySelector('[data-rm="list"]');
  const addButton = container.querySelector('[data-rm="add"]');

  const visibleRows = () => {
    const term = state.search.trim().toLowerCase();
    return state.data.items.filter((row) => (!hasStatus || state.status === 'all' || config.statusOf(row) === state.status)
      && (!term || config.searchText(row).toLowerCase().includes(term)));
  };

  const render = () => {
    const rows = visibleRows();
    if (!rows.length) {
      listBox.innerHTML = stateHtml(state.data.items.length
        ? { icon: 'search', title: `No ${config.entityPlural.toLowerCase()} match`, message: 'Try another search or status.' }
        : { icon: config.icon ?? 'inbox', title: `No ${config.entityPlural.toLowerCase()} yet`, message: `Use “Add ${config.entity.toLowerCase()}” to create one.` });
      return;
    }
    listBox.innerHTML = `
      <div class="table-responsive">
        <table class="table table-hover align-middle">
          <thead><tr>
            ${config.columns.map((col) => `<th class="${HIDE_BELOW[col.hideBelow] ?? ''} ${col.numeric ? 'num' : ''}">${escapeHtml(col.label)}</th>`).join('')}
            ${hasStatus ? '<th class="d-none d-sm-table-cell">Status</th>' : ''}
            <th class="text-end"><span class="visually-hidden">Actions</span></th>
          </tr></thead>
          <tbody>
            ${rows.map((row) => `
              <tr>
                ${config.columns.map((col) => `<td class="${HIDE_BELOW[col.hideBelow] ?? ''} ${col.numeric ? 'num' : ''}">${col.html(row)}</td>`).join('')}
                ${hasStatus ? `<td class="d-none d-sm-table-cell">${statusBadge(config.statusOf(row))}</td>` : ''}
                <td class="text-end">${actionsHtml(row)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="px-3 py-2 border-top small text-secondary">${rows.length} of ${state.data.items.length} shown</div>`;
  };

  const actionsHtml = (row) => {
    const id = escapeHtml(row[config.idField]);
    const button = (action, icon, label, extra = '') => `<li><button class="dropdown-item${extra}" type="button" data-rm-action="${action}" data-rm-id="${id}"><i class="bi bi-${icon} me-2" aria-hidden="true"></i>${escapeHtml(label)}</button></li>`;
    const disabledItem = (action, reason) => `<li><span class="dropdown-item disabled"><i class="bi bi-${action.icon} me-2" aria-hidden="true"></i>${escapeHtml(action.label)}<br><span class="small">${escapeHtml(reason)}</span></span></li>`;
    const extras = (config.extraActions ?? []).filter((action) => action.show(row))
      .map((action) => (action.disabledReason?.(row) ? disabledItem(action, action.disabledReason(row)) : button(action.id, action.icon, action.label)));
    const active = hasStatus && config.statusOf(row) === 'active';
    return `
      <div class="dropdown">
        <button class="btn btn-sm btn-light border" type="button" data-bs-toggle="dropdown" aria-expanded="false" aria-label="Actions for ${escapeHtml(config.nameOf(row))}">
          <i class="bi bi-three-dots" aria-hidden="true"></i>
        </button>
        <ul class="dropdown-menu dropdown-menu-end shadow-sm">
          ${button('edit', 'pencil', 'Edit')}
          ${extras.join('')}
          ${hasStatus ? `<li><hr class="dropdown-divider"></li>${active ? button('deactivate', 'slash-circle', 'Deactivate', ' text-danger') : button('activate', 'check-circle', 'Activate')}` : ''}
        </ul>
      </div>`;
  };

  const load = async () => {
    const requestId = ++state.request;
    if (!state.data) listBox.innerHTML = `<div class="card-body">${[1, 2, 3].map(() => '<div class="skeleton mb-2" style="height:44px"></div>').join('')}</div>`;
    try {
      const data = await callApi(config.listAction);
      if (requestId !== state.request) return;
      state.data = data;
      addButton.disabled = false;
      render();
    } catch (error) {
      if (requestId !== state.request) return;
      listBox.innerHTML = errorStateHtml(error.message);
      listBox.querySelector('[data-action="retry"]').addEventListener('click', load);
    }
  };

  const openForm = async (row = null) => {
    const fields = config.formFields(row, state.data);
    const result = await openFormModal({
      title: row ? `Edit ${config.entity.toLowerCase()}` : `Add ${config.entity.toLowerCase()}`,
      bodyHtml: `<div class="row g-3">${fields.map(fieldHtml).join('')}</div>${row && config.editNotice ? config.editNotice(row) : ''}`,
      submitLabel: row ? 'Save changes' : `Add ${config.entity.toLowerCase()}`,
      onSubmit: async (values) => (row
        ? callApi(config.updateAction, { ...values, [config.idField]: row[config.idField] })
        : { ...await callApi(config.createAction, values), username: values.username }),
    });
    if (result) {
      await showTempPassword(result); // new accounts only: shown once
      showToast(config.savedMessage?.(result, Boolean(row)) ?? `${config.entity} ${row ? 'saved' : 'added'}.`);
      await load();
    }
  };

  const changeStatus = async (row, status) => {
    const deactivate = status === 'inactive';
    const { confirmed } = await confirmAction({
      title: `${deactivate ? 'Deactivate' : 'Activate'} ${config.nameOf(row)}?`,
      message: deactivate ? config.deactivateMessage : config.activateMessage ?? `It will be available again.`,
      confirmLabel: deactivate ? 'Deactivate' : 'Activate',
      tone: deactivate ? 'danger' : 'primary',
      run: () => callApi(config.statusAction, { [config.idField]: row[config.idField], status }),
    });
    if (confirmed) {
      showToast(`${config.entity} ${deactivate ? 'deactivated' : 'activated'}.`);
      await load();
    }
  };

  container.addEventListener('click', (event) => {
    if (event.target.closest('[data-rm="add"]')) {
      openForm();
      return;
    }
    const trigger = event.target.closest('[data-rm-action]');
    if (!trigger) return;
    const row = state.data?.items.find((item) => String(item[config.idField]) === trigger.dataset.rmId);
    if (!row) return;
    const action = trigger.dataset.rmAction;
    if (action === 'edit') openForm(row);
    else if (action === 'deactivate') changeStatus(row, 'inactive');
    else if (action === 'activate') changeStatus(row, 'active');
    else config.extraActions?.find((item) => item.id === action)?.run(row, { reload: load });
  });

  container.querySelector(`#${config.key}Search`).addEventListener('input', (event) => {
    state.search = event.target.value;
    if (state.data) render();
  });
  container.querySelector(`#${config.key}Status`)?.addEventListener('change', (event) => {
    state.status = event.target.value;
    if (state.data) render();
  });

  load();
  return { reload: load };
}
