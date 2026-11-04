import { requireRole } from '../auth.js';
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
        <p class="page-subtitle">Instructors sign in with the Google account registered here. There is no self-registration.</p>
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
    searchText: (row) => `${row.first_name} ${row.last_name} ${row.email} ${row.department}`,
    columns: [
      { label: 'Instructor', html: (row) => `<div class="cell-main">${escapeHtml(`${row.first_name} ${row.last_name}`)}</div><div class="cell-sub d-lg-none text-break">${escapeHtml(row.email)}</div>` },
      { label: 'Email', hideBelow: 'lg', html: (row) => `<span class="small">${escapeHtml(row.email)}</span>` },
      { label: 'Department', hideBelow: 'md', html: (row) => escapeHtml(row.department) },
      { label: 'Classes', numeric: true, html: (row) => row.class_count },
      { label: 'Google', hideBelow: 'lg', html: (row) => (row.google_linked ? 'Linked' : '<span class="text-secondary">Not signed in yet</span>') },
    ],
    formFields: (row) => [
      { name: 'first_name', label: 'First name', required: true, half: true, maxlength: 60, value: row?.first_name },
      { name: 'last_name', label: 'Last name', required: true, half: true, maxlength: 60, value: row?.last_name },
      { name: 'email', label: 'Google account email', type: 'email', required: true, maxlength: 120, value: row?.email, help: 'The instructor signs in with this Google account.' },
      { name: 'department', label: 'Department', required: true, maxlength: 80, value: row?.department ?? 'Computer Engineering' },
    ],
    editNotice: (row) => (row.google_linked
      ? '<div class="alert alert-warning small mt-3 mb-0">Changing the email unlinks the current Google account. The instructor must sign in again with the new email.</div>'
      : ''),
    savedMessage: (result, editing) => {
      if (!editing) return 'Instructor added.';
      return result.google_unlinked ? 'Saved. The previous Google account was unlinked.' : 'Instructor saved.';
    },
  });
}
