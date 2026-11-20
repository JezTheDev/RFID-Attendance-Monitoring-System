import { callApi } from '../api.js';
import { requireRole } from '../auth.js';
import {
  renderShell, escapeHtml, formatDateTime, formatRelative, stateHtml, errorStateHtml,
  openFormModal, confirmAction, showToast, showTempPassword,
} from '../ui.js';
import {
  statusBadge, accountStateHtml, resetPasswordFlow, unlockFlow,
} from '../components/resource-manager.js';

const PAGE_SIZE = 20;
const CARD_STATUS = {
  active: { label: 'Active', classes: 'bg-success-subtle text-success-emphasis border border-success-subtle' },
  lost: { label: 'Lost', classes: 'bg-danger-subtle text-danger-emphasis border border-danger-subtle' },
  revoked: { label: 'Revoked', classes: 'bg-secondary-subtle text-secondary-emphasis border border-secondary-subtle' },
};

const session = requireRole('admin');
if (session) start();

function start() {
  const content = renderShell({ role: 'admin', active: 'students', title: 'Students & Cards', session });
  const state = { search: '', section_id: '', status: 'active', card: 'all', page: 1, sections: [], detailsId: null, accounts: new Map() };
  // student_id -> { account, name }: what the reset / unlock actions need
  const remember = (student, account) => state.accounts.set(student.student_id, { account, name: fullName(student) });
  let listRequest = 0;
  let searchTimer = null;

  content.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">Students &amp; RFID cards</h2>
        <p class="page-subtitle" id="studentCounts">Loading…</p>
      </div>
      <button type="button" class="btn btn-primary" id="addStudentButton" disabled>
        <i class="bi bi-person-plus me-1" aria-hidden="true"></i>Add student
      </button>
    </div>
    <div class="card mb-3">
      <div class="card-body">
        <form class="row g-2 align-items-end" id="filterForm" role="search">
          <div class="col-12 col-lg-4">
            <label class="form-label small text-secondary mb-1" for="searchInput">Search</label>
            <input type="search" class="form-control" id="searchInput" placeholder="Name, student number, email, or card UID" autocomplete="off">
          </div>
          <div class="col-6 col-lg-3">
            <label class="form-label small text-secondary mb-1" for="sectionFilter">Section</label>
            <select class="form-select" id="sectionFilter"><option value="">All sections</option></select>
          </div>
          <div class="col-6 col-lg-2">
            <label class="form-label small text-secondary mb-1" for="statusFilter">Status</label>
            <select class="form-select" id="statusFilter">
              <option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option>
            </select>
          </div>
          <div class="col-6 col-lg-2">
            <label class="form-label small text-secondary mb-1" for="cardFilter">RFID card</label>
            <select class="form-select" id="cardFilter">
              <option value="all">Any</option><option value="with">Has card</option><option value="without">No card</option>
            </select>
          </div>
          <div class="col-6 col-lg-1 d-grid">
            <button type="button" class="btn btn-light border" id="clearFilters">Clear</button>
          </div>
        </form>
      </div>
    </div>
    <div class="card mb-3 d-none" id="optionsError"></div>
    <div class="card" id="studentsCard"></div>
    <div class="offcanvas offcanvas-end" tabindex="-1" id="studentDetails" aria-labelledby="studentDetailsTitle" style="--bs-offcanvas-width: 440px">
      <div class="offcanvas-header border-bottom">
        <h2 class="offcanvas-title fs-5" id="studentDetailsTitle">Student details</h2>
        <button type="button" class="btn-close" data-bs-dismiss="offcanvas" aria-label="Close"></button>
      </div>
      <div class="offcanvas-body" id="studentDetailsBody"></div>
    </div>`;

  const listCard = document.getElementById('studentsCard');
  const detailsPanel = new window.bootstrap.Offcanvas(document.getElementById('studentDetails'));
  document.getElementById('studentDetails').addEventListener('hidden.bs.offcanvas', () => { state.detailsId = null; });

  const loadOptions = async () => {
    const errorBox = document.getElementById('optionsError');
    errorBox.classList.add('d-none');
    try {
      const options = await callApi('admin.getStudentOptions');
      state.sections = options.sections;
      document.getElementById('sectionFilter').insertAdjacentHTML('beforeend',
        options.sections.map((s) => `<option value="${escapeHtml(s.section_id)}">${escapeHtml(s.label)}</option>`).join(''));
      document.getElementById('addStudentButton').disabled = false;
    } catch (error) {
      errorBox.innerHTML = errorStateHtml(`Could not load sections: ${error.message}`);
      errorBox.querySelector('[data-action="retry"]').addEventListener('click', loadOptions);
      errorBox.classList.remove('d-none');
    }
  };

  const loadList = async () => {
    const requestId = ++listRequest;
    listCard.setAttribute('aria-busy', 'true');
    if (!listCard.querySelector('table')) {
      listCard.innerHTML = `<div class="card-body">${[1, 2, 3, 4, 5].map(() => '<div class="skeleton mb-2" style="height:44px"></div>').join('')}</div>`;
    }
    try {
      const data = await callApi('admin.listStudents', {
        search: state.search, section_id: state.section_id, status: state.status, card: state.card,
        page: state.page, page_size: PAGE_SIZE,
      });
      if (requestId !== listRequest) return;
      if (data.items.length === 0 && data.total > 0 && state.page > 1) {
        state.page = Math.ceil(data.total / PAGE_SIZE);
        loadList();
        return;
      }
      document.getElementById('studentCounts').textContent = `${data.counts.active} active · ${data.counts.inactive} inactive · ${data.counts.without_card} active without a card`;
      data.items.forEach((student) => remember(student, student.account));
      listCard.innerHTML = listHtml(data, state);
    } catch (error) {
      if (requestId !== listRequest) return;
      document.getElementById('studentCounts').textContent = '';
      listCard.innerHTML = errorStateHtml(error.message);
      listCard.querySelector('[data-action="retry"]').addEventListener('click', loadList);
    } finally {
      if (requestId === listRequest) listCard.removeAttribute('aria-busy');
    }
  };

  const refresh = async () => {
    await loadList();
    if (state.detailsId) loadDetails(state.detailsId);
  };

  const loadDetails = async (studentId) => {
    state.detailsId = studentId;
    const body = document.getElementById('studentDetailsBody');
    body.innerHTML = '<div class="skeleton mb-3" style="height:120px"></div><div class="skeleton" style="height:200px"></div>';
    detailsPanel.show();
    try {
      const data = await callApi('admin.getStudent', { student_id: studentId });
      if (state.detailsId !== studentId) return;
      remember(data.student, data.account);
      body.innerHTML = detailsHtml(data);
    } catch (error) {
      body.innerHTML = errorStateHtml(error.message);
      body.querySelector('[data-action="retry"]').addEventListener('click', () => loadDetails(studentId));
    }
  };

  const actions = {
    details: (id) => loadDetails(id),
    edit: (id) => editStudent(id, state, refresh),
    card: (id) => assignCardFlow(id, refresh),
    revoke: (id) => revokeCardFlow(id, refresh),
    reset: (id) => resetPasswordFlow(state.accounts.get(id).account, state.accounts.get(id).name, refresh),
    unlock: (id) => unlockFlow(state.accounts.get(id).account, state.accounts.get(id).name, refresh),
    deactivate: (id) => statusFlow(id, 'inactive', refresh),
    activate: (id) => statusFlow(id, 'active', refresh),
  };

  content.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-student-action]');
    if (trigger) {
      event.preventDefault();
      actions[trigger.dataset.studentAction]?.(trigger.dataset.studentId);
      return;
    }
    const pager = event.target.closest('[data-page]');
    if (pager && !pager.disabled) {
      state.page = Number(pager.dataset.page);
      loadList();
    }
  });

  document.getElementById('addStudentButton').addEventListener('click', () => createStudentFlow(state, refresh));
  document.getElementById('filterForm').addEventListener('submit', (event) => event.preventDefault());
  document.getElementById('searchInput').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = event.target.value;
      state.page = 1;
      loadList();
    }, 300);
  });
  [['sectionFilter', 'section_id'], ['statusFilter', 'status'], ['cardFilter', 'card']].forEach(([id, key]) => {
    document.getElementById(id).addEventListener('change', (event) => {
      state[key] = event.target.value;
      state.page = 1;
      loadList();
    });
  });
  document.getElementById('clearFilters').addEventListener('click', () => {
    Object.assign(state, { search: '', section_id: '', status: 'active', card: 'all', page: 1 });
    document.getElementById('searchInput').value = '';
    document.getElementById('sectionFilter').value = '';
    document.getElementById('statusFilter').value = 'active';
    document.getElementById('cardFilter').value = 'all';
    loadList();
  });

  loadOptions();
  loadList();
}

function fullName(student) {
  return `${student.first_name} ${student.last_name}`;
}

function cardCellHtml(card) {
  if (!card) return '<span class="badge rounded-pill bg-warning-subtle text-warning-emphasis border border-warning-subtle">No card</span>';
  return `<span class="font-monospace small">${escapeHtml(card.rfid_uid)}</span>`;
}

function actionMenuHtml(student) {
  const id = escapeHtml(student.student_id);
  const item = (action, icon, label, extra = '') => `<li><button class="dropdown-item${extra}" type="button" data-student-action="${action}" data-student-id="${id}"><i class="bi bi-${icon} me-2" aria-hidden="true"></i>${label}</button></li>`;
  const active = student.account_status === 'active';
  return `
    <div class="dropdown">
      <button class="btn btn-sm btn-light border" type="button" data-bs-toggle="dropdown" aria-expanded="false" aria-label="Actions for ${escapeHtml(fullName(student))}">
        <i class="bi bi-three-dots" aria-hidden="true"></i>
      </button>
      <ul class="dropdown-menu dropdown-menu-end shadow-sm">
        ${item('details', 'person-vcard', 'View details')}
        ${item('edit', 'pencil', 'Edit student')}
        ${active ? item('card', 'credit-card-2-front', student.card ? 'Replace card' : 'Assign card') : ''}
        ${active && student.card ? item('revoke', 'x-octagon', 'Revoke card') : ''}
        ${student.account?.user_id ? item('reset', 'key', 'Reset password') : ''}
        ${student.account?.locked ? item('unlock', 'unlock', 'Unlock') : ''}
        <li><hr class="dropdown-divider"></li>
        ${active ? item('deactivate', 'person-dash', 'Deactivate', ' text-danger') : item('activate', 'person-check', 'Activate')}
      </ul>
    </div>`;
}

function listHtml(data, state) {
  if (!data.items.length) {
    const filtered = state.search || state.section_id || state.status !== 'active' || state.card !== 'all';
    return stateHtml(filtered
      ? { icon: 'search', title: 'No students match these filters', message: 'Try a different search or clear the filters.' }
      : { icon: 'people', title: 'No students yet', message: 'Use “Add student” to register the first student.' });
  }
  const first = (data.page - 1) * data.page_size + 1;
  const last = first + data.items.length - 1;
  const pages = Math.ceil(data.total / data.page_size);
  return `
    <div class="table-responsive">
      <table class="table table-hover align-middle">
        <thead>
          <tr>
            <th>Student</th><th class="d-none d-md-table-cell">Section</th><th class="d-none d-lg-table-cell">Email</th>
            <th>RFID card</th><th class="d-none d-sm-table-cell">Status</th><th class="text-end"><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          ${data.items.map((student) => `
            <tr>
              <td>
                <button type="button" class="btn btn-link p-0 text-start text-decoration-none cell-main" data-student-action="details" data-student-id="${escapeHtml(student.student_id)}">${escapeHtml(fullName(student))}</button>
                <div class="cell-sub">${escapeHtml(student.student_number)}<span class="d-md-none"> · ${escapeHtml(student.section_label)}</span></div>
                ${!student.account?.user_id || student.account.locked || student.account.must_change_password ? `<div class="mt-1">${accountStateHtml(student.account)}</div>` : ''}
                <div class="d-sm-none mt-1">${student.account_status === 'active' ? '' : statusBadge(student.account_status)}</div>
              </td>
              <td class="d-none d-md-table-cell">${escapeHtml(student.section_label)}</td>
              <td class="d-none d-lg-table-cell small">${escapeHtml(student.email)}</td>
              <td>${cardCellHtml(student.card)}</td>
              <td class="d-none d-sm-table-cell">${statusBadge(student.account_status)}</td>
              <td class="text-end">${actionMenuHtml(student)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 px-3 py-2 border-top small text-secondary">
      <span>Showing ${first}–${last} of ${data.total}</span>
      <div class="btn-group btn-group-sm">
        <button type="button" class="btn btn-light border" data-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''}>Previous</button>
        <button type="button" class="btn btn-light border" data-page="${data.page + 1}" ${data.page >= pages ? 'disabled' : ''}>Next</button>
      </div>
    </div>`;
}

function detailsHtml({ student, account, cards, enrollments, attendance }) {
  const id = escapeHtml(student.student_id);
  const active = student.account_status === 'active';
  const button = (action, icon, label, tone = 'light border') => `<button type="button" class="btn btn-sm btn-${tone}" data-student-action="${action}" data-student-id="${id}"><i class="bi bi-${icon} me-1" aria-hidden="true"></i>${label}</button>`;
  return `
    <div class="d-flex align-items-start justify-content-between gap-2 mb-1">
      <div>
        <div class="fs-5 fw-semibold">${escapeHtml(fullName(student))}</div>
        <div class="text-secondary small">${escapeHtml(student.student_number)} · ${escapeHtml(student.section_label)}</div>
      </div>
      ${statusBadge(student.account_status)}
    </div>
    <div class="d-flex flex-wrap gap-2 my-3">
      ${button('edit', 'pencil', 'Edit')}
      ${active ? button('card', 'credit-card-2-front', student.card ? 'Replace card' : 'Assign card') : ''}
      ${active && student.card ? button('revoke', 'x-octagon', 'Revoke card') : ''}
      ${account?.user_id ? button('reset', 'key', 'Reset password') : ''}
      ${account?.locked ? button('unlock', 'unlock', 'Unlock') : ''}
      ${active ? button('deactivate', 'person-dash', 'Deactivate', 'outline-danger') : button('activate', 'person-check', 'Activate', 'outline-primary')}
    </div>

    <h3 class="h6 text-uppercase text-secondary small fw-semibold mt-4">Sign-in account</h3>
    <dl class="row small mb-0">
      <dt class="col-4 fw-normal text-secondary">Username</dt><dd class="col-8 font-monospace">${escapeHtml(account?.username ?? '')}</dd>
      <dt class="col-4 fw-normal text-secondary">Email</dt><dd class="col-8 text-break">${escapeHtml(account?.email || student.email || '—')}</dd>
      <dt class="col-4 fw-normal text-secondary">Account</dt><dd class="col-8">${account ? escapeHtml(account.account_status) : '<span class="text-danger">Missing user record</span>'}</dd>
      <dt class="col-4 fw-normal text-secondary">Password</dt><dd class="col-8">${account?.locked ? `<span class="text-danger">Locked until ${escapeHtml(formatDateTime(account.locked_until))} (too many failed sign-ins)</span>` : account?.must_change_password ? 'Temporary password (not changed yet)' : 'Changed by the student'}</dd>
      <dt class="col-4 fw-normal text-secondary">Last sign-in</dt><dd class="col-8">${account?.last_login_at ? escapeHtml(formatDateTime(account.last_login_at)) : '—'}</dd>
    </dl>

    <h3 class="h6 text-uppercase text-secondary small fw-semibold mt-4">RFID cards</h3>
    ${cards.length ? `<ul class="list-group list-group-flush small">${cards.map((card) => `
      <li class="list-group-item px-0">
        <div class="d-flex justify-content-between gap-2">
          <span class="font-monospace">${escapeHtml(card.rfid_uid)}</span>
          <span class="badge rounded-pill ${CARD_STATUS[card.status]?.classes ?? ''}">${escapeHtml(CARD_STATUS[card.status]?.label ?? card.status)}</span>
        </div>
        <div class="text-secondary">Assigned ${escapeHtml(formatDateTime(card.assigned_at))}${card.revoked_at ? ` · ended ${escapeHtml(formatDateTime(card.revoked_at))}` : ''}</div>
        ${card.notes ? `<div class="text-secondary">${escapeHtml(card.notes)}</div>` : ''}
      </li>`).join('')}</ul>` : '<p class="small text-secondary">No card has been assigned yet.</p>'}

    <h3 class="h6 text-uppercase text-secondary small fw-semibold mt-4">Classes</h3>
    ${enrollments.length ? `<ul class="list-group list-group-flush small">${enrollments.map((row) => `
      <li class="list-group-item px-0 d-flex justify-content-between gap-2">
        <span><span class="fw-semibold">${escapeHtml(row.class_label)}</span><br><span class="text-secondary">${escapeHtml(row.subject_title)}</span></span>
        <span class="text-secondary text-nowrap">${escapeHtml(row.status)}</span>
      </li>`).join('')}</ul>` : '<p class="small text-secondary">Not enrolled in any class.</p>'}

    <h3 class="h6 text-uppercase text-secondary small fw-semibold mt-4">Attendance</h3>
    <p class="small mb-0">${attendance.records} recorded scan(s), ${attendance.late} late.
      ${attendance.last_scan_at ? `Last scan ${escapeHtml(formatRelative(attendance.last_scan_at))}.` : 'No scans yet.'}</p>`;
}

function studentFormHtml(sections, student = null) {
  const value = (field) => escapeHtml(student?.[field] ?? '');
  const field = (name, label, input, help = '') => `
    <div class="mb-3">
      <label class="form-label" for="f_${name}">${label}</label>
      ${input}
      <div class="invalid-feedback" data-error-for="${name}"></div>
      ${help ? `<div class="form-text">${help}</div>` : ''}
    </div>`;
  return `
    ${field('student_number', 'Student number', `<input class="form-control" id="f_student_number" name="student_number" inputmode="numeric" pattern="\\d{10}" maxlength="10" required value="${value('student_number')}">`, '10 digits, for example 2026000001.')}
    <div class="row g-2">
      <div class="col-sm-6">${field('first_name', 'First name', `<input class="form-control" id="f_first_name" name="first_name" maxlength="60" required autocomplete="off" value="${value('first_name')}">`)}</div>
      <div class="col-sm-6">${field('last_name', 'Last name', `<input class="form-control" id="f_last_name" name="last_name" maxlength="60" required autocomplete="off" value="${value('last_name')}">`)}</div>
    </div>
    ${field('section_id', 'Section', `<select class="form-select" id="f_section_id" name="section_id" required>
      <option value="">Choose a section</option>
      ${sections.map((s) => `<option value="${escapeHtml(s.section_id)}"${s.section_id === student?.section_id ? ' selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}
    </select>`)}
    ${field('email', 'Email (optional)', `<input type="email" class="form-control" id="f_email" name="email" maxlength="120" autocomplete="off" value="${value('email')}">`, 'The student signs in with their student number and the temporary password shown once after saving, then chooses their own. There is no self-registration.')}`;
}

async function createStudentFlow(state, refresh) {
  const result = await openFormModal({
    title: 'Add student',
    bodyHtml: studentFormHtml(state.sections),
    submitLabel: 'Add student',
    onSubmit: async (values) => ({ ...await callApi('admin.createStudent', values), username: values.student_number }),
  });
  if (result) {
    await showTempPassword(result); // shown once
    const joined = result.classes_joined
      ? ` Enrolled in ${result.classes_joined} class${result.classes_joined === 1 ? '' : 'es'} of their section.`
      : '';
    showToast(`Student and sign-in account created.${joined} You can now assign an RFID card.`);
    await refresh();
  }
}

async function editStudent(studentId, state, refresh) {
  let data;
  try {
    data = await callApi('admin.getStudent', { student_id: studentId });
  } catch (error) {
    showToast(error.message, 'danger');
    return;
  }
  const result = await openFormModal({
    title: `Edit ${fullName(data.student)}`,
    bodyHtml: studentFormHtml(state.sections, data.student)
      + '<div class="alert alert-info small mb-0">The student number is also the student’s username.</div>',
    submitLabel: 'Save changes',
    onSubmit: (values) => callApi('admin.updateStudent', { ...values, student_id: studentId }),
  });
  if (result) {
    const { dropped = [], enrolled = [] } = result.enrollment_changes ?? {};
    const moved = (dropped.length ? ` Dropped from: ${dropped.join(', ')}.` : '')
      + (enrolled.length ? ` Enrolled in: ${enrolled.join(', ')}.` : '');
    showToast(`Student details saved.${moved}`);
    await refresh();
  }
}

async function assignCardFlow(studentId, refresh) {
  let student;
  let unregistered = [];
  try {
    const [details, uids] = await Promise.all([
      callApi('admin.getStudent', { student_id: studentId }),
      callApi('admin.listUnregisteredUids'),
    ]);
    student = details.student;
    unregistered = uids.items;
  } catch (error) {
    showToast(error.message, 'danger');
    return;
  }
  const replacing = Boolean(student.card);
  const suggestions = unregistered.length
    ? `<div class="list-group list-group-flush border rounded mb-3" style="max-height:180px;overflow:auto">
        ${unregistered.map((row) => `
          <button type="button" class="list-group-item list-group-item-action d-flex justify-content-between align-items-center small" data-fill-uid="${escapeHtml(row.rfid_uid)}">
            <span class="font-monospace">${escapeHtml(row.rfid_uid)}</span>
            <span class="text-secondary">${escapeHtml(row.room_code)} · ${escapeHtml(formatRelative(row.last_seen_at))}</span>
          </button>`).join('')}
      </div>`
    : '<p class="small text-secondary">No recent unregistered taps. Tap the new card on any online reader, then reopen this dialog — or type the UID below.</p>';

  const promise = openFormModal({
    title: replacing ? 'Replace RFID card' : 'Assign RFID card',
    bodyHtml: `
      <p class="mb-3"><span class="fw-semibold">${escapeHtml(fullName(student))}</span> <span class="text-secondary">· ${escapeHtml(student.student_number)}</span></p>
      ${replacing ? `
        <div class="alert alert-light border small">Current card: <span class="font-monospace">${escapeHtml(student.card.rfid_uid)}</span>. It will stop working as soon as the new card is saved.</div>
        <div class="mb-3">
          <label class="form-label" for="f_replace_reason">Why is the card being replaced?</label>
          <select class="form-select" id="f_replace_reason" name="replace_reason" required>
            <option value="">Choose a reason</option><option value="lost">Lost</option><option value="damaged">Damaged</option><option value="other">Other</option>
          </select>
          <div class="invalid-feedback" data-error-for="replace_reason"></div>
        </div>` : ''}
      <div class="form-label">Recent unregistered taps</div>
      ${suggestions}
      <div class="mb-3">
        <label class="form-label" for="f_rfid_uid">Card UID</label>
        <input class="form-control font-monospace text-uppercase" id="f_rfid_uid" name="rfid_uid" required maxlength="29" autocomplete="off" placeholder="e.g. 04A1B2C3">
        <div class="invalid-feedback" data-error-for="rfid_uid"></div>
        <div class="form-text">Hexadecimal UID from the reader. Spaces and colons are removed automatically.</div>
      </div>
      <div class="mb-0">
        <label class="form-label" for="f_note">Note <span class="text-secondary">(optional)</span></label>
        <input class="form-control" id="f_note" name="note" maxlength="200" autocomplete="off">
      </div>`,
    submitLabel: replacing ? 'Replace card' : 'Assign card',
    onSubmit: (values) => callApi('admin.assignCard', { ...values, student_id: studentId }),
  });

  document.querySelectorAll('[data-fill-uid]').forEach((button) => button.addEventListener('click', () => {
    const input = document.getElementById('f_rfid_uid');
    input.value = button.dataset.fillUid;
    input.focus();
  }));

  const result = await promise;
  if (result) {
    showToast(replacing ? 'Card replaced. The old card no longer works.' : 'Card assigned.');
    await refresh();
  }
}

async function revokeCardFlow(studentId, refresh) {
  const { confirmed } = await confirmAction({
    title: 'Revoke RFID card?',
    message: 'The card will be rejected by every reader immediately. Attendance history is kept.',
    confirmLabel: 'Revoke card',
    tone: 'danger',
    reasonLabel: 'Reason',
    run: (values) => callApi('admin.revokeCard', { student_id: studentId, reason: values.reason }),
  });
  if (confirmed) {
    showToast('Card revoked.');
    await refresh();
  }
}

async function statusFlow(studentId, status, refresh) {
  const deactivate = status === 'inactive';
  const { confirmed, data } = await confirmAction({
    title: deactivate ? 'Deactivate student?' : 'Activate student?',
    message: deactivate
      ? 'The student will no longer be able to sign in, and their active RFID card will be revoked. Attendance history is kept.'
      : 'The student will be able to sign in again. Assign a card separately if needed.',
    confirmLabel: deactivate ? 'Deactivate' : 'Activate',
    tone: deactivate ? 'danger' : 'primary',
    reasonLabel: 'Reason',
    run: (values) => callApi('admin.setStudentStatus', { student_id: studentId, status, reason: values.reason }),
  });
  if (confirmed) {
    showToast(deactivate
      ? `Student deactivated${data?.revoked_card_id ? ' and card revoked' : ''}.`
      : 'Student activated.');
    await refresh();
  }
}
