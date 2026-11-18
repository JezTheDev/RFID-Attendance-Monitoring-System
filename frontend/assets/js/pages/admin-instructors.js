import { requireRole, appUrl } from '../auth.js';
import { renderShell, escapeHtml } from '../ui.js';
import { mountResourceManager } from '../components/resource-manager.js';

const session = requireRole('admin');
if (session) start();

function start() {
  const content = renderShell({ role: 'admin', active: 'instructors', title: 'Instructors', session });
  content.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">Instructors</h2>
        <p class="page-subtitle">Instructors sign in with the username created here and the default instructor password, then choose their own. There is no self-registration.</p>
      </div>
    </div>
    <div id="instructorManager"></div>`;

  mountResourceManager(document.getElementById('instructorManager'), {
    key: 'instructors',
    entity: 'Instructor',
    entityPlural: 'Instructors',
    idField: 'instructor_id',
    icon: 'person-video3',
    listAction: 'admin.listInstructors',
    createAction: 'admin.createInstructor',
    updateAction: 'admin.updateInstructor',
    statusAction: 'admin.setInstructorStatus',
    deactivateMessage: 'They will no longer be able to sign in. Instructors with active classes must have those classes reassigned first.',
    activateMessage: 'They will be able to sign in again.',
    nameOf: (row) => `${row.first_name} ${row.last_name}`,
    statusOf: (row) => row.status,
    searchText: (row) => `${row.first_name} ${row.last_name} ${row.username} ${row.email} ${row.department}`,
    columns: [
      { label: 'Instructor', html: (row) => `<div class="cell-main">${escapeHtml(`${row.first_name} ${row.last_name}`)}</div><div class="cell-sub d-lg-none text-break">${escapeHtml(row.username)}</div>` },
      { label: 'Username', hideBelow: 'lg', html: (row) => `<span class="small font-monospace">${escapeHtml(row.username)}</span>` },
      { label: 'Department', hideBelow: 'md', html: (row) => escapeHtml(row.department) },
      { label: 'Classes', numeric: true, html: (row) => `<a class="text-decoration-none" href="${classesLink({ q: `${row.first_name} ${row.last_name}` })}" title="See this instructor's classes">${row.class_count}</a>` },
      { label: 'Sign-in', hideBelow: 'lg', html: (row) => (row.locked ? '<span class="badge text-bg-danger">Locked</span>' : row.must_change_password ? '<span class="text-secondary">Default password</span>' : 'Active') },
    ],
    formFields: (row) => [
      { name: 'first_name', label: 'First name', required: true, half: true, maxlength: 60, value: row?.first_name },
      { name: 'last_name', label: 'Last name', required: true, half: true, maxlength: 60, value: row?.last_name },
      { name: 'username', label: 'Username', required: true, maxlength: 32, value: row?.username, help: '3-32 lowercase letters, numbers, dots, hyphens or underscores. Used to sign in; must be unique.' },
      { name: 'email', label: 'Email', type: 'email', maxlength: 120, value: row?.email },
      { name: 'department', label: 'Department', required: true, maxlength: 80, value: row?.department ?? 'Computer Engineering' },
    ],
    extraActions: [
      {
        id: 'assign', label: 'Assign subject & section', icon: 'journal-plus',
        show: (row) => row.status === 'active',
        run: (row) => { window.location.href = classesLink({ assign: row.instructor_id }); },
      },
      {
        id: 'classes', label: 'View assigned classes', icon: 'calendar-week',
        show: (row) => row.class_count > 0,
        run: (row) => { window.location.href = classesLink({ q: `${row.first_name} ${row.last_name}` }); },
      },
    ],
    savedMessage: (_result, editing) => (editing
      ? 'Instructor saved.'
      : 'Instructor created. They sign in with this username and the default instructor password. Use “Assign subject & section” next.'),
  });
}

function classesLink(params) {
  return `${appUrl('admin/classes.html')}?${new URLSearchParams(params)}`;
}
