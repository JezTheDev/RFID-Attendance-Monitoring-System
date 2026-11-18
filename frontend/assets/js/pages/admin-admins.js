import { requireRole } from '../auth.js';
import { renderShell, escapeHtml, formatDateTime } from '../ui.js';
import { mountResourceManager } from '../components/resource-manager.js';

const session = requireRole('admin');
if (session) start();

function start() {
  const content = renderShell({ role: 'admin', active: 'admins', title: 'Administrators', session });
  content.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">Administrators</h2>
        <p class="page-subtitle">People who can manage the whole system. They sign in with the Google account registered here.</p>
      </div>
    </div>
    <div id="adminManager"></div>`;

  mountResourceManager(document.getElementById('adminManager'), {
    key: 'admins',
    entity: 'Administrator',
    entityPlural: 'Administrators',
    idField: 'user_id',
    icon: 'shield-lock',
    description: 'Administrators have full access: accounts, RFID cards, classes, schedules and all attendance. Only add people who need it.',
    listAction: 'admin.listAdmins',
    createAction: 'admin.createAdmin',
    updateAction: 'admin.updateAdmin',
    statusAction: 'admin.setAdminStatus',
    deactivateMessage: 'They are signed out right away and can no longer sign in. You cannot deactivate yourself or the last active administrator.',
    activateMessage: 'They will be able to sign in again.',
    nameOf: (row) => row.display_name,
    statusOf: (row) => row.status,
    searchText: (row) => `${row.display_name} ${row.email}`,
    columns: [
      { label: 'Name', html: (row) => `<div class="cell-main">${escapeHtml(row.display_name)}${row.is_you ? ' <span class="badge text-bg-light border ms-1">You</span>' : ''}</div><div class="cell-sub d-md-none text-break">${escapeHtml(row.email)}</div>` },
      { label: 'Email', hideBelow: 'md', html: (row) => `<span class="small">${escapeHtml(row.email)}</span>` },
      { label: 'Google', hideBelow: 'lg', html: (row) => (row.google_linked ? 'Linked' : '<span class="text-secondary">Not signed in yet</span>') },
      { label: 'Last sign-in', hideBelow: 'lg', html: (row) => (row.last_login_at ? escapeHtml(formatDateTime(row.last_login_at)) : '<span class="text-secondary">—</span>') },
    ],
    formFields: (row) => [
      { name: 'display_name', label: 'Full name', required: true, maxlength: 80, value: row?.display_name === 'Administrator' ? '' : row?.display_name },
      { name: 'email', label: 'Google account email', type: 'email', required: true, maxlength: 120, value: row?.email, help: 'This creates their sign-in account. They sign in with this Google account.' },
    ],
    editNotice: (row) => (row.google_linked
      ? '<div class="alert alert-warning small mt-3 mb-0">Changing the email unlinks the current Google account. They must sign in again with the new email.</div>'
      : ''),
    savedMessage: (result, editing) => {
      if (!editing) return 'Administrator account created.';
      return result.google_unlinked ? 'Saved. The previous Google account was unlinked.' : 'Administrator saved.';
    },
  });
}
