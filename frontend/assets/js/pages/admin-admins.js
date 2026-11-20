import { requireRole } from '../auth.js';
import { renderShell, escapeHtml, formatDateTime } from '../ui.js';
import {
  mountResourceManager, accountStateHtml, resetPasswordFlow, unlockFlow,
} from '../components/resource-manager.js';

const session = requireRole('admin');
if (session) start();

function start() {
  const content = renderShell({ role: 'admin', active: 'admins', title: 'Administrators', session });
  content.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">Administrators</h2>
        <p class="page-subtitle">People who can manage the whole system. They sign in with the username created here and the temporary password shown once after you add them, then choose their own.</p>
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
    searchText: (row) => `${row.display_name} ${row.username} ${row.email}`,
    columns: [
      { label: 'Name', html: (row) => `<div class="cell-main">${escapeHtml(row.display_name)}${row.is_you ? ' <span class="badge text-bg-light border ms-1">You</span>' : ''}</div><div class="cell-sub d-md-none text-break">${escapeHtml(row.username)}</div><div class="d-lg-none mt-1">${accountStateHtml(row)}</div>` },
      { label: 'Username', hideBelow: 'md', html: (row) => `<span class="small font-monospace">${escapeHtml(row.username)}</span>` },
      { label: 'Sign-in', hideBelow: 'lg', html: (row) => accountStateHtml(row) },
      { label: 'Last sign-in', hideBelow: 'lg', html: (row) => (row.last_login_at ? escapeHtml(formatDateTime(row.last_login_at)) : '<span class="text-secondary">—</span>') },
    ],
    formFields: (row) => [
      { name: 'display_name', label: 'Full name', required: true, maxlength: 80, value: row?.display_name === 'Administrator' ? '' : row?.display_name },
      { name: 'username', label: 'Username', required: true, maxlength: 32, value: row?.username, help: '3-32 lowercase letters, numbers, dots, hyphens or underscores. Used to sign in; must be unique.' },
      { name: 'email', label: 'Email', type: 'email', maxlength: 120, value: row?.email },
    ],
    extraActions: [
      {
        id: 'reset-password', label: 'Reset password', icon: 'key',
        show: () => true,
        disabledReason: (row) => (row.is_you ? 'Not for your own account. Ask another administrator.' : ''),
        run: (row, { reload }) => resetPasswordFlow(row, row.display_name, reload),
      },
      {
        id: 'unlock', label: 'Unlock', icon: 'unlock',
        show: (row) => row.locked,
        run: (row, { reload }) => unlockFlow(row, row.display_name, reload),
      },
    ],
    savedMessage: (_result, editing) => (editing
      ? 'Administrator saved.'
      : 'Administrator created.'),
  });
}
