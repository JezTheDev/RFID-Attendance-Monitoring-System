import { callApi } from '../api.js';
import { requireRole } from '../auth.js';
import { renderShell, escapeHtml, confirmAction, showToast } from '../ui.js';
import { mountResourceManager } from '../components/resource-manager.js';

function formatDate(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })
    .format(new Date(Date.UTC(year, month - 1, day)));
}

function muted(value) {
  return `<span class="text-secondary">${escapeHtml(value)}</span>`;
}

const TABS = [
  {
    key: 'terms',
    label: 'Terms',
    config: {
      entity: 'Term', entityPlural: 'Terms', idField: 'term_id', icon: 'calendar-range',
      listAction: 'admin.listTerms', createAction: 'admin.createTerm', updateAction: 'admin.updateTerm',
      description: 'Only one term is active at a time. Schedules and attendance use the active term. Term dates cannot overlap.',
      nameOf: (row) => row.term_name,
      searchText: (row) => row.term_name,
      columns: [
        { label: 'Term', html: (row) => `<div class="cell-main">${escapeHtml(row.term_name)}${row.is_active ? ' <span class="badge rounded-pill text-bg-primary ms-1">Active term</span>' : ''}</div>` },
        { label: 'Dates', html: (row) => `${escapeHtml(formatDate(row.start_date))} – ${escapeHtml(formatDate(row.end_date))}` },
        { label: 'Classes', numeric: true, hideBelow: 'sm', html: (row) => row.class_count },
      ],
      formFields: (row) => [
        { name: 'term_name', label: 'Term name', required: true, maxlength: 80, value: row?.term_name, placeholder: '2nd Semester AY 2026-2027' },
        { name: 'start_date', label: 'Start date', type: 'date', required: true, half: true, value: row?.start_date },
        { name: 'end_date', label: 'End date', type: 'date', required: true, half: true, value: row?.end_date },
      ],
      extraActions: [{
        id: 'set-active', label: 'Set as active term', icon: 'check2-circle',
        show: (row) => !row.is_active,
        run: async (row, { reload }) => {
          const { confirmed } = await confirmAction({
            title: `Make "${row.term_name}" the active term?`,
            message: 'The current active term will become inactive. Automatic class sessions will only be created for schedules in the active term.',
            confirmLabel: 'Set active',
            run: () => callApi('admin.setActiveTerm', { term_id: row.term_id }),
          });
          if (confirmed) {
            showToast('Active term updated.');
            await reload();
          }
        },
      }],
    },
  },
  {
    key: 'programs',
    label: 'Programs',
    config: {
      entity: 'Program', entityPlural: 'Programs', idField: 'program_id', icon: 'mortarboard',
      listAction: 'admin.listPrograms', createAction: 'admin.createProgram', updateAction: 'admin.updateProgram', statusAction: 'admin.setProgramStatus',
      deactivateMessage: 'It will no longer be available for new sections. A program with active sections or students cannot be deactivated.',
      nameOf: (row) => row.program_code,
      statusOf: (row) => row.status,
      searchText: (row) => `${row.program_code} ${row.program_name}`,
      columns: [
        { label: 'Code', html: (row) => `<span class="cell-main">${escapeHtml(row.program_code)}</span>` },
        { label: 'Name', hideBelow: 'md', html: (row) => escapeHtml(row.program_name) },
        { label: 'Sections', numeric: true, html: (row) => row.section_count },
        { label: 'Students', numeric: true, hideBelow: 'sm', html: (row) => row.student_count },
      ],
      formFields: (row) => [
        { name: 'program_code', label: 'Program code', required: true, maxlength: 20, value: row?.program_code, placeholder: 'BSCpE' },
        { name: 'program_name', label: 'Program name', required: true, maxlength: 120, value: row?.program_name },
      ],
    },
  },
  {
    key: 'sections',
    label: 'Sections',
    config: {
      entity: 'Section', entityPlural: 'Sections', idField: 'section_id', icon: 'diagram-3',
      listAction: 'admin.listSections', createAction: 'admin.createSection', updateAction: 'admin.updateSection', statusAction: 'admin.setSectionStatus',
      deactivateMessage: 'It will no longer be available for students and classes. A section with active students or classes cannot be deactivated.',
      nameOf: (row) => row.label,
      statusOf: (row) => row.status,
      searchText: (row) => `${row.label} ${row.program_code}`,
      columns: [
        { label: 'Section', html: (row) => `<span class="cell-main">${escapeHtml(row.label)}</span>` },
        { label: 'Year', numeric: true, hideBelow: 'sm', html: (row) => row.year_level },
        { label: 'Students', numeric: true, html: (row) => row.student_count },
        { label: 'Classes', numeric: true, hideBelow: 'sm', html: (row) => row.class_count },
      ],
      formFields: (row, data) => [
        { name: 'program_id', label: 'Program', type: 'select', required: true, value: row?.program_id, options: data.programs, placeholder: 'Choose a program' },
        { name: 'year_level', label: 'Year level', type: 'number', required: true, half: true, min: 1, max: 5, value: row?.year_level },
        { name: 'section_name', label: 'Section name', required: true, half: true, maxlength: 20, uppercase: true, value: row?.section_name, placeholder: '3A' },
      ],
    },
  },
  {
    key: 'subjects',
    label: 'Subjects',
    config: {
      entity: 'Subject', entityPlural: 'Subjects', idField: 'subject_id', icon: 'book',
      listAction: 'admin.listSubjects', createAction: 'admin.createSubject', updateAction: 'admin.updateSubject', statusAction: 'admin.setSubjectStatus',
      deactivateMessage: 'It will no longer be available for new classes. A subject used by active classes cannot be deactivated.',
      nameOf: (row) => row.subject_code,
      statusOf: (row) => row.status,
      searchText: (row) => `${row.subject_code} ${row.subject_title}`,
      columns: [
        { label: 'Code', html: (row) => `<div class="cell-main">${escapeHtml(row.subject_code)}</div><div class="cell-sub d-md-none">${escapeHtml(row.subject_title)}</div>` },
        { label: 'Title', hideBelow: 'md', html: (row) => escapeHtml(row.subject_title) },
        { label: 'Units', numeric: true, html: (row) => escapeHtml(row.units) },
        { label: 'Classes', numeric: true, hideBelow: 'sm', html: (row) => row.class_count },
      ],
      formFields: (row) => [
        { name: 'subject_code', label: 'Subject code', required: true, half: true, maxlength: 20, uppercase: true, value: row?.subject_code, placeholder: 'CPE 401' },
        { name: 'units', label: 'Units', type: 'number', required: true, half: true, min: 1, max: 10, value: row?.units },
        { name: 'subject_title', label: 'Subject title', required: true, maxlength: 120, value: row?.subject_title },
      ],
    },
  },
  {
    key: 'rooms',
    label: 'Rooms',
    config: {
      entity: 'Room', entityPlural: 'Rooms', idField: 'room_id', icon: 'door-open',
      listAction: 'admin.listRooms', createAction: 'admin.createRoom', updateAction: 'admin.updateRoom', statusAction: 'admin.setRoomStatus',
      description: 'Each room gets one RFID reader. Devices are assigned to rooms on the Devices page.',
      deactivateMessage: 'It will no longer be available for schedules. A room with active schedules or an assigned device cannot be deactivated.',
      nameOf: (row) => row.room_code,
      statusOf: (row) => row.status,
      searchText: (row) => `${row.room_code} ${row.room_name} ${row.building}`,
      columns: [
        { label: 'Room', html: (row) => `<div class="cell-main">${escapeHtml(row.room_code)}</div><div class="cell-sub">${escapeHtml(row.room_name)}</div>` },
        { label: 'Building', hideBelow: 'md', html: (row) => (row.building ? escapeHtml(row.building) : muted('—')) },
        { label: 'Schedules', numeric: true, hideBelow: 'sm', html: (row) => row.schedule_count },
        { label: 'Reader', html: (row) => (row.device_id ? `<span class="font-monospace small">${escapeHtml(row.device_id)}</span>` : muted('None')) },
      ],
      formFields: (row) => [
        { name: 'room_code', label: 'Room code', required: true, half: true, maxlength: 20, uppercase: true, value: row?.room_code, placeholder: 'RM301', help: 'No spaces.' },
        { name: 'room_name', label: 'Room name', required: true, half: true, maxlength: 80, value: row?.room_name },
        { name: 'building', label: 'Building', maxlength: 80, value: row?.building },
      ],
    },
  },
];

function start() {
  const content = renderShell({ role: 'admin', active: 'academic', title: 'Academic Setup', session });
  content.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">Academic setup</h2>
        <p class="page-subtitle">Terms, programs, sections, subjects, and rooms used by classes and schedules.</p>
      </div>
    </div>
    <div class="tab-scroll mb-3">
      <ul class="nav nav-pills flex-nowrap" role="tablist">
        ${TABS.map((tab) => `<li class="nav-item" role="presentation"><button class="nav-link" type="button" role="tab" id="tab-${tab.key}" data-tab="${tab.key}" aria-controls="panel-${tab.key}" aria-selected="false">${escapeHtml(tab.label)}</button></li>`).join('')}
      </ul>
    </div>
    ${TABS.map((tab) => `<section class="d-none" role="tabpanel" id="panel-${tab.key}" aria-labelledby="tab-${tab.key}"></section>`).join('')}`;

  const mounted = new Map();
  const show = (key) => {
    const tab = TABS.find((item) => item.key === key) ?? TABS[0];
    TABS.forEach((item) => {
      const active = item.key === tab.key;
      const button = document.getElementById(`tab-${item.key}`);
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      document.getElementById(`panel-${item.key}`).classList.toggle('d-none', !active);
    });
    if (mounted.has(tab.key)) mounted.get(tab.key).reload();
    else mounted.set(tab.key, mountResourceManager(document.getElementById(`panel-${tab.key}`), { key: tab.key, ...tab.config }));
    if (window.location.hash !== `#${tab.key}`) history.replaceState(null, '', `#${tab.key}`);
  };

  content.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => show(button.dataset.tab)));
  window.addEventListener('hashchange', () => show(window.location.hash.slice(1)));
  show(window.location.hash.slice(1));
}

const session = requireRole('admin');
if (session) start();
