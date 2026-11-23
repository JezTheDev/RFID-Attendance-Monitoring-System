import { callApi } from '../api.js';
import { requireRole } from '../auth.js';
import {
  renderShell, escapeHtml, stateHtml, errorStateHtml, openFormModal, confirmAction, showToast,
} from '../ui.js';
import { statusBadge } from '../components/resource-manager.js';
import { scheduleHtml, getParam, setParams } from '../components/attendance-ui.js';

const DAYS = [['MON', 'Monday'], ['TUE', 'Tuesday'], ['WED', 'Wednesday'], ['THU', 'Thursday'], ['FRI', 'Friday'], ['SAT', 'Saturday'], ['SUN', 'Sunday']];

const session = requireRole('admin');
if (session) start();

function start() {
  const content = renderShell({ role: 'admin', active: 'classes', title: 'Classes & Schedules', session });
  const state = {
    termId: getParam('term'), search: getParam('q'), status: 'active', options: null, data: null, detailsId: getParam('class'), request: 0,
  };

  content.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">Classes &amp; schedules</h2>
        <p class="page-subtitle">Assign each subject and section to an instructor, set when and where it meets, and choose the students.</p>
      </div>
      <button type="button" class="btn btn-primary" id="addClassButton" disabled>
        <i class="bi bi-plus-lg me-1" aria-hidden="true"></i>Add class
      </button>
    </div>
    <div class="card mb-3">
      <div class="card-body">
        <form class="row g-2 align-items-end" id="filterForm" role="search">
          <div class="col-12 col-lg-4">
            <label class="form-label small text-secondary mb-1" for="termFilter">Term</label>
            <select class="form-select" id="termFilter"><option value="">Loading…</option></select>
          </div>
          <div class="col-12 col-sm-7 col-lg-5">
            <label class="form-label small text-secondary mb-1" for="searchInput">Search</label>
            <input type="search" class="form-control" id="searchInput" placeholder="Subject, section, or instructor" autocomplete="off">
          </div>
          <div class="col-12 col-sm-5 col-lg-3">
            <label class="form-label small text-secondary mb-1" for="statusFilter">Status</label>
            <select class="form-select" id="statusFilter">
              <option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option>
            </select>
          </div>
        </form>
      </div>
    </div>
    <div class="card mb-3 d-none" id="optionsError"></div>
    <div class="card" id="classList"></div>
    <div class="offcanvas offcanvas-end" tabindex="-1" id="classDetails" aria-labelledby="classDetailsTitle" style="--bs-offcanvas-width: 520px">
      <div class="offcanvas-header border-bottom">
        <h2 class="offcanvas-title fs-5" id="classDetailsTitle">Class</h2>
        <button type="button" class="btn-close" data-bs-dismiss="offcanvas" aria-label="Close"></button>
      </div>
      <div class="offcanvas-body" id="classDetailsBody"></div>
    </div>`;

  const list = document.getElementById('classList');
  const termFilter = document.getElementById('termFilter');
  const panelElement = document.getElementById('classDetails');
  const panel = new window.bootstrap.Offcanvas(panelElement);
  const panelBody = document.getElementById('classDetailsBody');
  panelElement.addEventListener('hidden.bs.offcanvas', () => {
    state.detailsId = '';
    setParams({ class: '' });
  });

  const loadOptions = async () => {
    const errorBox = document.getElementById('optionsError');
    errorBox.classList.add('d-none');
    try {
      state.options = await callApi('admin.getClassOptions');
      fillTermFilter();
      document.getElementById('addClassButton').disabled = false;
      return true;
    } catch (error) {
      errorBox.innerHTML = errorStateHtml(`Could not load terms, subjects, sections, instructors and rooms: ${error.message}`);
      errorBox.querySelector('[data-action="retry"]').addEventListener('click', async () => {
        await loadOptions();
      });
      errorBox.classList.remove('d-none');
      return false;
    }
  };

  // Needs both options (terms) and the list (selected term); runs after whichever arrives last.
  const fillTermFilter = () => {
    if (!state.options || !state.data) return;
    termFilter.innerHTML = state.options.terms.map((t) => `<option value="${escapeHtml(t.value)}"${t.value === state.termId ? ' selected' : ''}>${escapeHtml(t.label.replace(/ \(active\)$/, ' ✓'))}</option>`).join('')
      || '<option value="">No terms yet</option>';
  };

  const loadList = async () => {
    const requestId = ++state.request;
    if (!state.data) list.innerHTML = `<div class="card-body">${[1, 2, 3, 4].map(() => '<div class="skeleton mb-2" style="height:52px"></div>').join('')}</div>`;
    try {
      const data = await callApi('admin.listClasses', { term_id: state.termId });
      if (requestId !== state.request) return;
      state.data = data;
      state.termId = data.term_id;
      setParams({ term: state.termId });
      fillTermFilter();
      renderList();
    } catch (error) {
      if (requestId !== state.request) return;
      list.innerHTML = errorStateHtml(error.message);
      list.querySelector('[data-action="retry"]').addEventListener('click', loadList);
    }
  };

  const renderList = () => {
    const term = state.search.trim().toLowerCase();
    const rows = state.data.items.filter((row) => (state.status === 'all' || row.status === state.status)
      && (!term || `${row.class_label} ${row.subject_title} ${row.section_label} ${row.instructor_name}`.toLowerCase().includes(term)));
    if (!rows.length) {
      list.innerHTML = stateHtml(state.data.items.length
        ? { icon: 'search', title: 'No classes match', message: 'Try another search or status.' }
        : { icon: 'calendar-week', title: 'No classes in this term yet', message: 'Use “Add class” to assign a subject and section to an instructor.' });
      return;
    }
    list.innerHTML = `
      <div class="table-responsive">
        <table class="table table-hover align-middle mb-0">
          <thead><tr>
            <th>Class</th><th class="d-none d-md-table-cell">Instructor</th><th class="d-none d-xl-table-cell">Schedule</th>
            <th class="num d-none d-sm-table-cell">Students</th><th class="d-none d-sm-table-cell">Status</th><th class="text-end"><span class="visually-hidden">Actions</span></th>
          </tr></thead>
          <tbody>
            ${rows.map((row) => `
              <tr>
                <td>
                  <button type="button" class="btn btn-link p-0 text-start text-decoration-none cell-main text-nowrap" data-open="${escapeHtml(row.class_id)}">${escapeHtml(row.class_label)}</button>
                  <div class="cell-sub">${escapeHtml(row.subject_title)}<span class="d-md-none"> · ${escapeHtml(row.instructor_name)}</span></div>
                  <div class="cell-sub d-xl-none">${row.schedules.map((s) => `<span class="d-block text-nowrap">${escapeHtml(s.day)} ${escapeHtml(s.start_time)}–${escapeHtml(s.end_time)} · ${escapeHtml(s.room_code)}</span>`).join('')}</div>
                  <div class="cell-sub d-sm-none">${row.enrolled} student${row.enrolled === 1 ? '' : 's'}</div>
                  ${row.schedules.length ? '' : '<span class="badge bg-warning-subtle text-warning-emphasis border border-warning-subtle mt-1">No schedule yet</span>'}
                </td>
                <td class="d-none d-md-table-cell">${escapeHtml(row.instructor_name)}</td>
                <td class="d-none d-xl-table-cell"><div class="schedule-list mt-0">${row.schedules.length ? scheduleHtml(row.schedules) : '<span class="text-secondary small">—</span>'}</div></td>
                <td class="num d-none d-sm-table-cell">${row.enrolled}</td>
                <td class="d-none d-sm-table-cell">${statusBadge(row.status)}</td>
                <td class="text-end"><button type="button" class="btn btn-sm btn-light border" data-open="${escapeHtml(row.class_id)}">Manage</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="px-3 py-2 border-top small text-secondary">${rows.length} of ${state.data.items.length} shown</div>`;
  };

  const loadDetails = async (classId) => {
    state.detailsId = classId;
    setParams({ class: classId });
    panelBody.innerHTML = '<div class="skeleton mb-3" style="height:110px"></div><div class="skeleton mb-3" style="height:140px"></div><div class="skeleton" style="height:220px"></div>';
    panel.show();
    try {
      const data = await callApi('admin.getClass', { class_id: classId });
      if (state.detailsId !== classId) return;
      state.details = data;
      panelBody.innerHTML = detailsHtml(data);
    } catch (error) {
      panelBody.innerHTML = errorStateHtml(error.message);
      panelBody.querySelector('[data-action="retry"]').addEventListener('click', () => loadDetails(classId));
    }
  };

  const refresh = () => Promise.all([loadList(), state.detailsId && loadDetails(state.detailsId)]);

  const actions = {
    edit: () => editClassFlow(state, refresh),
    status: (value) => classStatusFlow(state, value, refresh),
    'add-schedule': () => addScheduleFlow(state, refresh),
    'remove-schedule': (id) => removeScheduleFlow(state, id, refresh),
    'add-students': () => addStudentsFlow(state, refresh),
    drop: (id) => dropFlow(state, id, refresh),
  };

  content.addEventListener('click', (event) => {
    const open = event.target.closest('[data-open]');
    if (open) return void loadDetails(open.dataset.open);
    const action = event.target.closest('[data-class-action]');
    if (action) actions[action.dataset.classAction]?.(action.dataset.value);
  });
  document.getElementById('addClassButton').addEventListener('click', () => createClassFlow(state, async (classId) => {
    await loadList();
    loadDetails(classId);
  }));
  termFilter.addEventListener('change', () => {
    state.termId = termFilter.value;
    loadList();
  });
  document.getElementById('searchInput').addEventListener('input', (event) => {
    state.search = event.target.value;
    if (state.data) renderList();
  });
  document.getElementById('statusFilter').addEventListener('change', (event) => {
    state.status = event.target.value;
    if (state.data) renderList();
  });
  document.getElementById('filterForm').addEventListener('submit', (event) => event.preventDefault());

  (async () => {
    document.getElementById('searchInput').value = state.search;
    if (state.detailsId) loadDetails(state.detailsId);
    await Promise.all([loadOptions(), loadList()]);
    // Coming from Instructors → "Assign subject & section"
    const assignTo = getParam('assign');
    if (assignTo && state.options) {
      setParams({ assign: '' });
      createClassFlow(state, async (classId) => {
        await loadList();
        loadDetails(classId);
      }, assignTo);
    }
  })();
}

/* ---------------- details panel ---------------- */

function detailsHtml({ class: klass, students }) {
  const active = klass.status === 'active';
  const button = (action, icon, label, tone = 'light border', value = '') => `<button type="button" class="btn btn-sm btn-${tone}" data-class-action="${action}" data-value="${escapeHtml(value)}"><i class="bi bi-${icon} me-1" aria-hidden="true"></i>${label}</button>`;
  const sectionCount = students.filter((s) => s.section_id === klass.section_id).length;
  return `
    <div class="d-flex align-items-start justify-content-between gap-2">
      <div class="min-w-0">
        <div class="class-card-code">${escapeHtml(klass.subject_code)} · ${escapeHtml(klass.section_label)}</div>
        <div class="fs-5 fw-semibold">${escapeHtml(klass.subject_title)}</div>
        <div class="small text-secondary">${escapeHtml(klass.term_name)}</div>
      </div>
      ${statusBadge(klass.status)}
    </div>
    <dl class="row small mt-3 mb-0">
      <dt class="col-4 fw-normal text-secondary">Instructor</dt><dd class="col-8 fw-semibold">${escapeHtml(klass.instructor_name)}</dd>
    </dl>
    <div class="d-flex flex-wrap gap-2 my-3">
      ${button('edit', 'pencil', 'Edit instructor')}
      ${active ? button('status', 'slash-circle', 'Deactivate', 'outline-danger', 'inactive') : button('status', 'check-circle', 'Activate', 'outline-primary', 'active')}
    </div>

    <div class="d-flex justify-content-between align-items-center mt-4 mb-2">
      <h3 class="h6 text-uppercase text-secondary small fw-semibold mb-0">Weekly schedule</h3>
      ${active ? button('add-schedule', 'plus-lg', 'Add') : ''}
    </div>
    ${klass.schedules.length
      ? `<ul class="list-group small">${klass.schedules.map((slot) => `
          <li class="list-group-item d-flex justify-content-between align-items-center gap-2">
            <div class="schedule-list mt-0">${scheduleHtml([slot])}</div>
            <button type="button" class="btn btn-sm btn-link text-danger p-0" data-class-action="remove-schedule" data-value="${escapeHtml(slot.schedule_id)}" aria-label="Remove ${escapeHtml(`${slot.day} ${slot.start_time}`)}"><i class="bi bi-trash" aria-hidden="true"></i></button>
          </li>`).join('')}</ul>`
      : '<div class="alert alert-warning small mb-0"><i class="bi bi-exclamation-triangle me-1" aria-hidden="true"></i>No schedule yet. RFID taps for this class are only accepted during its scheduled times.</div>'}

    <div class="d-flex justify-content-between align-items-center mt-4 mb-2">
      <h3 class="h6 text-uppercase text-secondary small fw-semibold mb-0">Students <span class="badge text-bg-light border ms-1">${students.length}</span></h3>
      ${active ? button('add-students', 'person-plus', 'Add students') : ''}
    </div>
    <p class="small text-secondary mb-2">${sectionCount} from ${escapeHtml(klass.section_label)}${students.length > sectionCount ? ` · ${students.length - sectionCount} from other sections` : ''}</p>
    ${students.length
      ? `<ul class="list-group list-group-flush small">${students.map((s) => `
          <li class="list-group-item px-0 d-flex justify-content-between align-items-center gap-2">
            <div class="min-w-0">
              <div class="fw-semibold">${escapeHtml(s.name)}${s.account_status === 'active' ? '' : ' <span class="badge text-bg-light border">inactive</span>'}</div>
              <div class="text-secondary">${escapeHtml(s.student_number)}${s.section_id === klass.section_id ? '' : ` · ${escapeHtml(s.section_label)}`}</div>
            </div>
            ${active ? `<button type="button" class="btn btn-sm btn-light border" data-class-action="drop" data-value="${escapeHtml(s.student_id)}">Drop</button>` : ''}
          </li>`).join('')}</ul>`
      : stateHtml({ icon: 'people', title: 'No students enrolled' })}`;
}

/* ---------------- forms ---------------- */

function selectField(name, label, options, value = '', help = '') {
  return `
    <div class="col-12">
      <label class="form-label" for="f_${name}">${escapeHtml(label)}</label>
      <select class="form-select" id="f_${name}" name="${name}" required>
        <option value="">Choose…</option>
        ${options.map((o) => `<option value="${escapeHtml(o.value)}"${o.value === value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
      </select>
      <div class="invalid-feedback" data-error-for="${name}"></div>
      ${help ? `<div class="form-text">${escapeHtml(help)}</div>` : ''}
    </div>`;
}

async function createClassFlow(state, done, instructorId = '') {
  const o = state.options;
  const activeTerm = o.terms.find((t) => t.active)?.value ?? '';
  const result = await openFormModal({
    title: 'Add class',
    bodyHtml: `<div class="row g-3">
      ${selectField('term_id', 'Term', o.terms, state.termId || activeTerm)}
      ${selectField('subject_id', 'Subject', o.subjects)}
      ${selectField('section_id', 'Section', o.sections, '', 'All active students of this section are enrolled automatically. You can add or drop students afterwards.')}
      ${selectField('instructor_id', 'Instructor', o.instructors, instructorId)}
    </div>`,
    submitLabel: 'Add class',
    onSubmit: (values) => callApi('admin.createClass', values),
  });
  if (result) {
    showToast(`${result.class_label} added with ${result.enrolled} student${result.enrolled === 1 ? '' : 's'}. Now add its schedule.`);
    done(result.class_id);
  }
}

async function editClassFlow(state, refresh) {
  const klass = state.details.class;
  const result = await openFormModal({
    title: `Edit ${klass.class_label}`,
    bodyHtml: `<div class="row g-3">
      ${selectField('instructor_id', 'Instructor', state.options.instructors, klass.instructor_id, 'The new instructor sees this class, its sessions and reports right away.')}
    </div>`,
    submitLabel: 'Save changes',
    onSubmit: (values) => callApi('admin.updateClass', { ...values, class_id: klass.class_id }),
  });
  if (result) {
    showToast('Class saved.');
    refresh();
  }
}

async function classStatusFlow(state, status, refresh) {
  const klass = state.details.class;
  const deactivate = status === 'inactive';
  const { confirmed } = await confirmAction({
    title: `${deactivate ? 'Deactivate' : 'Activate'} ${klass.class_label}?`,
    message: deactivate
      ? 'The class disappears from the instructor and student portals, and RFID taps are no longer matched to it. Its attendance history is kept.'
      : 'The class will be visible again and RFID taps will be matched to its schedule.',
    confirmLabel: deactivate ? 'Deactivate' : 'Activate',
    tone: deactivate ? 'danger' : 'primary',
    run: () => callApi('admin.setClassStatus', { class_id: klass.class_id, status }),
  });
  if (confirmed) {
    showToast(`Class ${deactivate ? 'deactivated' : 'activated'}.`);
    refresh();
  }
}

async function addScheduleFlow(state, refresh) {
  const klass = state.details.class;
  const result = await openFormModal({
    title: `Add schedule · ${klass.class_label}`,
    bodyHtml: `<div class="row g-3">
      ${selectField('day_of_week', 'Day', DAYS.map(([value, label]) => ({ value, label })))}
      <div class="col-6">
        <label class="form-label" for="f_start_time">Start</label>
        <input type="time" class="form-control" id="f_start_time" name="start_time" required step="300">
        <div class="invalid-feedback" data-error-for="start_time"></div>
      </div>
      <div class="col-6">
        <label class="form-label" for="f_end_time">End</label>
        <input type="time" class="form-control" id="f_end_time" name="end_time" required step="300">
        <div class="invalid-feedback" data-error-for="end_time"></div>
      </div>
      ${selectField('room_id', 'Room', state.options.rooms, '', 'The RFID reader in this room records attendance for this class at these times.')}
    </div>
    <p class="small text-secondary mt-3 mb-0"><i class="bi bi-shield-check me-1" aria-hidden="true"></i>Checked against other classes: the room, ${escapeHtml(klass.instructor_name)}, and ${escapeHtml(klass.section_label)} must all be free.</p>`,
    submitLabel: 'Add schedule',
    onSubmit: (values) => callApi('admin.addSchedule', { ...values, class_id: klass.class_id }),
  });
  if (result) {
    showToast('Schedule added.');
    refresh();
  }
}

async function removeScheduleFlow(state, scheduleId, refresh) {
  const slot = state.details.class.schedules.find((s) => s.schedule_id === scheduleId);
  const { confirmed } = await confirmAction({
    title: 'Remove this schedule?',
    message: `${slot.day} ${slot.start_time}–${slot.end_time} in ${slot.room_code}. Past attendance for these meetings is kept.`,
    confirmLabel: 'Remove',
    tone: 'danger',
    run: () => callApi('admin.removeSchedule', { schedule_id: scheduleId }),
  });
  if (confirmed) {
    showToast('Schedule removed.');
    refresh();
  }
}

async function addStudentsFlow(state, refresh) {
  const { class: klass, candidates } = state.details;
  if (!candidates.length) {
    showToast('Every active student is already enrolled in this class.', 'info');
    return;
  }
  const result = await openFormModal({
    title: `Add students · ${klass.class_label}`,
    size: 'modal-lg',
    bodyHtml: `
      <input type="search" class="form-control mb-2" id="candidateSearch" placeholder="Search name, number, or section" autocomplete="off" aria-label="Search students">
      <div class="small text-secondary mb-2">Students of ${escapeHtml(klass.section_label)} are listed first (e.g. someone who was dropped). Others are for irregular or cross-section students.</div>
      <div class="list-group candidate-list" style="max-height:340px;overflow:auto">
        ${candidates.map((s) => `
          <label class="list-group-item d-flex gap-2 align-items-center" data-search="${escapeHtml(`${s.name} ${s.student_number} ${s.section_label}`.toLowerCase())}">
            <input class="form-check-input mt-0" type="checkbox" value="${escapeHtml(s.student_id)}" data-candidate>
            <span class="flex-grow-1">${escapeHtml(s.name)} <span class="text-secondary small">· ${escapeHtml(s.student_number)}</span></span>
            <span class="badge ${s.section_id === klass.section_id ? 'text-bg-primary' : 'text-bg-light border'}">${escapeHtml(s.section_label)}</span>
          </label>`).join('')}
      </div>
      <div class="invalid-feedback d-block" data-error-for="student_ids"></div>`,
    submitLabel: 'Enroll selected',
    onSubmit: (_values, form) => {
      const ids = [...form.querySelectorAll('[data-candidate]:checked')].map((box) => box.value);
      if (!ids.length) {
        const error = new Error('Tick at least one student.');
        error.fields = { student_ids: 'Tick at least one student.' };
        throw error;
      }
      return callApi('admin.enrollStudents', { class_id: klass.class_id, student_ids: ids });
    },
  });
  if (result) {
    showToast(`${result.added} student${result.added === 1 ? '' : 's'} enrolled.`);
    refresh();
  }
}

// Live filter for the "Add students" dialog
document.addEventListener('input', (event) => {
  if (event.target.id !== 'candidateSearch') return;
  const term = event.target.value.trim().toLowerCase();
  document.querySelectorAll('.candidate-list [data-search]').forEach((item) => {
    item.classList.toggle('d-none', Boolean(term) && !item.dataset.search.includes(term));
  });
});

async function dropFlow(state, studentId, refresh) {
  const { class: klass, students } = state.details;
  const student = students.find((s) => s.student_id === studentId);
  const { confirmed } = await confirmAction({
    title: `Drop ${student.name}?`,
    message: `They will be removed from ${klass.class_label}: no longer on the roster, and their RFID taps for this class are rejected. Past attendance is kept, and you can add them back later.`,
    confirmLabel: 'Drop student',
    tone: 'danger',
    reasonLabel: 'Reason',
    run: (values) => callApi('admin.dropEnrollment', { class_id: klass.class_id, student_id: studentId, reason: values.reason }),
  });
  if (confirmed) {
    showToast(`${student.name} dropped.`);
    refresh();
  }
}
