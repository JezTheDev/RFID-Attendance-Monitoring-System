import { callApi } from '../api.js';
import { requireRole } from '../auth.js';
import {
  renderShell, escapeHtml, formatClockTime, formatTimestamp, stateHtml, errorStateHtml,
  openFormModal, showToast,
} from '../ui.js';
import {
  ATTENDANCE_STATUS, attendanceBadge, phaseBadge, countsBarHtml, formatDateShort, formatRate,
  getParam, setParams, scheduleHtml, sessionOptionLabel, statusFilters, canCorrect, classOptionsHtml,
} from '../components/attendance-ui.js';
import { openStudentHistory, openClassRoster } from './instructor-history.js';

const session = requireRole('instructor');
if (session) start();

function start() {
  const content = renderShell({ role: 'instructor', active: 'attendance', title: 'Attendance', session });
  const state = { classId: getParam('class'), sessionId: getParam('session'), filter: 'all', search: '', data: null };
  let sessionsRequest = 0;
  let rosterRequest = 0;

  content.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">Attendance monitoring</h2>
        <p class="page-subtitle">Check who tapped in for each class session and correct records when needed.</p>
      </div>
      <button type="button" class="btn btn-light border" id="refreshButton"><i class="bi bi-arrow-clockwise me-1" aria-hidden="true"></i>Refresh</button>
    </div>
    <div class="card mb-3">
      <div class="card-body">
        <form class="row g-2 align-items-end" id="pickForm">
          <div class="col-12 col-md-5">
            <label class="form-label small text-secondary mb-1" for="classSelect">Class</label>
            <select class="form-select" id="classSelect"><option value="">Loading…</option></select>
          </div>
          <div class="col-12 col-md-7">
            <label class="form-label small text-secondary mb-1" for="sessionSelect">Session</label>
            <select class="form-select" id="sessionSelect" disabled><option value="">Choose a class first</option></select>
          </div>
        </form>
        <div class="schedule-list mt-2 small" id="classSchedule"></div>
      </div>
    </div>
    <div id="sessionBody"></div>`;

  const classSelect = document.getElementById('classSelect');
  const sessionSelect = document.getElementById('sessionSelect');
  const body = document.getElementById('sessionBody');
  document.getElementById('classSchedule').addEventListener('click', (event) => {
    const roster = event.target.closest('[data-roster]');
    if (roster) openClassRoster(roster.dataset.roster);
  });

  const loadSessions = async () => {
    const requestId = ++sessionsRequest;
    sessionSelect.disabled = true;
    try {
      const data = await callApi('instructor.listSessions', { class_id: state.classId });
      if (requestId !== sessionsRequest) return;
      const first = [...data.classes, ...(data.past_classes ?? [])][0];
      if (!state.classId && first) {
        state.classId = first.class_id;
        loadSessions();
        return;
      }
      classSelect.innerHTML = classOptionsHtml(data.classes, data.past_classes, state.classId);
      document.getElementById('classSchedule').innerHTML = data.class
        ? `${escapeHtml(data.class.subject_title)} · <button type="button" class="btn btn-link btn-sm p-0 align-baseline" data-roster="${escapeHtml(data.class.class_id)}">${data.class.enrolled} students</button> · ${scheduleHtml(data.class.schedules)}`
        : '';

      if (!data.sessions.length) {
        sessionSelect.innerHTML = '<option value="">No sessions recorded yet</option>';
        state.sessionId = '';
        setParams({ class: state.classId, session: '' });
        body.innerHTML = `<div class="card">${stateHtml({
          icon: 'calendar',
          title: 'No sessions yet',
          message: `Sessions appear here once students tap their RFID cards during class. ${data.class?.enrolled ?? 0} students are enrolled.`,
          action: `<button type="button" class="btn btn-primary btn-sm mt-3" data-roster="${escapeHtml(state.classId)}"><i class="bi bi-people me-1" aria-hidden="true"></i>View students</button>`,
        })}</div>`;
        return;
      }
      if (!data.sessions.some((row) => row.session_id === state.sessionId)) {
        state.sessionId = data.sessions[0].session_id;
      }
      sessionSelect.innerHTML = data.sessions.map((row) => `
        <option value="${escapeHtml(row.session_id)}"${row.session_id === state.sessionId ? ' selected' : ''}>
          ${escapeHtml(formatDateShort(row.session_date))} · ${formatClockTime(row.start_time)} · ${escapeHtml(sessionOptionLabel(row))}
        </option>`).join('');
      sessionSelect.disabled = false;
      loadRoster();
    } catch (error) {
      if (requestId !== sessionsRequest) return;
      body.innerHTML = `<div class="card">${errorStateHtml(error.message)}</div>`;
      body.querySelector('[data-action="retry"]').addEventListener('click', loadSessions);
    }
  };

  const loadRoster = async () => {
    const requestId = ++rosterRequest;
    setParams({ class: state.classId, session: state.sessionId });
    if (!body.querySelector('table')) {
      body.innerHTML = `<div class="card"><div class="card-body">${[1, 2, 3, 4, 5, 6].map(() => '<div class="skeleton mb-2" style="height:44px"></div>').join('')}</div></div>`;
    }
    try {
      const data = await callApi('instructor.getSession', { session_id: state.sessionId });
      if (requestId !== rosterRequest) return;
      state.data = data;
      renderRoster();
    } catch (error) {
      if (requestId !== rosterRequest) return;
      body.innerHTML = `<div class="card">${errorStateHtml(error.message)}</div>`;
      body.querySelector('[data-action="retry"]').addEventListener('click', loadRoster);
    }
  };

  const renderRoster = () => {
    body.innerHTML = rosterHtml(state);
    const search = body.querySelector('#rosterSearch');
    search.value = state.search;
    search.addEventListener('input', () => {
      state.search = search.value;
      body.querySelector('#rosterRows').innerHTML = rowsHtml(state);
    });
  };

  classSelect.addEventListener('change', () => {
    state.classId = classSelect.value;
    state.sessionId = '';
    state.filter = 'all';
    loadSessions();
  });
  sessionSelect.addEventListener('change', () => {
    state.sessionId = sessionSelect.value;
    loadRoster();
  });
  document.getElementById('refreshButton').addEventListener('click', loadSessions);

  body.addEventListener('click', (event) => {
    const filter = event.target.closest('[data-filter]');
    if (filter) {
      state.filter = filter.dataset.filter;
      body.querySelectorAll('[data-filter]').forEach((b) => {
        b.classList.toggle('active', b === filter);
        b.setAttribute('aria-pressed', String(b === filter));
      });
      body.querySelector('#rosterRows').innerHTML = rowsHtml(state);
      return;
    }
    const correct = event.target.closest('[data-correct]');
    if (correct) {
      correctFlow(state, correct.dataset.correct, () => loadSessions());
      return;
    }
    const history = event.target.closest('[data-history]');
    if (history) openStudentHistory(state.classId, history.dataset.history);
    const roster = event.target.closest('[data-roster]');
    if (roster) openClassRoster(roster.dataset.roster);
  });

  loadSessions();
}

function rosterHtml(state) {
  const { session: info, students, class: klass } = state.data;
  const cancelled = info.phase === 'cancelled';
  const filters = statusFilters(info, students);
  const live = filters.some(([value]) => value === 'not_scanned');
  if (!filters.some(([value]) => value === state.filter)) state.filter = 'all'; // e.g. "Not yet" kept from a running session
  const attended = (info.present ?? 0) + (info.late ?? 0);

  return `
    <div class="card">
      <div class="card-header border-bottom flex-wrap gap-2">
        <div class="min-w-0">
          <h3 class="card-title-sm mb-0">${escapeHtml(info.class_label)} · ${escapeHtml(formatDateShort(info.session_date))}</h3>
          <div class="cell-sub">${formatClockTime(info.start_time)}–${formatClockTime(info.end_time)} · ${escapeHtml(info.room_code)}${info.source === 'manual' ? ' · Manual session' : ''}</div>
        </div>
        ${phaseBadge(info)}
      </div>
      ${klass.status === 'active' ? '' : `<div class="card-body pb-0"><div class="alert alert-secondary mb-0"><i class="bi bi-archive me-1" aria-hidden="true"></i>This class is inactive (past). Its attendance is read-only.</div></div>`}
      ${cancelled
        ? `<div class="card-body pb-0"><div class="alert alert-secondary mb-0"><i class="bi bi-slash-circle me-1" aria-hidden="true"></i>This class was cancelled${info.reason ? `: ${escapeHtml(info.reason)}` : '.'} Attendance is not counted.</div></div>`
        : `<div class="card-body border-bottom">
            <div class="row g-2 text-center summary-tiles">
              <div class="col-6 col-md"><div class="summary-tile"><div class="summary-num">${formatRate(info.enrolled ? attended / info.enrolled : null)}</div><div class="summary-label">Attended</div></div></div>
              <div class="col-6 col-md"><div class="summary-tile tone-success"><div class="summary-num">${info.present ?? 0}</div><div class="summary-label">Present</div></div></div>
              <div class="col-6 col-md"><div class="summary-tile tone-warning"><div class="summary-num">${info.late ?? 0}</div><div class="summary-label">Late</div></div></div>
              ${live ? `<div class="col-6 col-md"><div class="summary-tile"><div class="summary-num">${info.not_scanned ?? 0}</div><div class="summary-label">Not yet</div></div></div>` : ''}
              <div class="col-6 col-md"><div class="summary-tile tone-danger"><div class="summary-num">${info.absent ?? 0}</div><div class="summary-label">Absent</div></div></div>
            </div>
            ${countsBarHtml(info).replace('class="att-bar"', 'class="att-bar att-bar-wide"')}
          </div>`}
      <div class="card-body d-flex flex-wrap gap-2 align-items-center justify-content-between py-2">
        <div class="btn-group btn-group-sm flex-wrap" role="group" aria-label="Filter by status">
          ${filters.map(([value, label, n]) => `<button type="button" class="btn btn-outline-secondary${state.filter === value ? ' active' : ''}" data-filter="${value}" aria-pressed="${state.filter === value}">${label} <span class="badge text-bg-light border ms-1">${n}</span></button>`).join('')}
        </div>
        <input type="search" class="form-control form-control-sm" id="rosterSearch" placeholder="Search name or number" style="max-width:240px" aria-label="Search students">
      </div>
      <div class="table-responsive">
        <table class="table table-hover align-middle mb-0">
          <thead><tr><th>Student</th><th>Status</th><th class="d-none d-sm-table-cell">Time in</th><th class="text-end"><span class="visually-hidden">Actions</span></th></tr></thead>
          <tbody id="rosterRows">${rowsHtml(state)}</tbody>
        </table>
      </div>
    </div>`;
}

function rowsHtml(state) {
  const { session: info, students, class: klass } = state.data;
  const term = state.search.trim().toLowerCase();
  const matchFilter = (row) => state.filter === 'all' || row.status === state.filter;
  const rows = students.filter((row) => matchFilter(row)
    && (!term || `${row.first_name} ${row.last_name} ${row.student_number}`.toLowerCase().includes(term)));
  if (!rows.length) {
    return `<tr><td colspan="4">${stateHtml({ icon: 'search', title: 'No students to show', message: 'Try another filter or search.' })}</td></tr>`;
  }
  const correctable = canCorrect(info, klass);
  return rows.map((row) => {
    const tags = [];
    if (row.corrected) tags.push(`<span class="badge text-bg-light border" title="${escapeHtml(row.correction_reason)}"><i class="bi bi-pencil-square me-1" aria-hidden="true"></i>Corrected</span>`);
    else if (row.source === 'manual') tags.push('<span class="badge text-bg-light border">Manual</span>');
    if (row.sync_mode === 'offline') tags.push('<span class="badge text-bg-light border"><i class="bi bi-cloud-arrow-up me-1" aria-hidden="true"></i>Offline sync</span>');
    return `
      <tr>
        <td>
          <button type="button" class="btn btn-link p-0 text-start text-decoration-none cell-main" data-history="${escapeHtml(row.student_id)}">${escapeHtml(`${row.last_name}, ${row.first_name}`)}</button>
          <div class="cell-sub">${escapeHtml(row.student_number)}</div>
        </td>
        <td><div class="d-flex flex-wrap gap-1 align-items-center">${attendanceBadge(row.status)}${tags.join('')}</div></td>
        <td class="d-none d-sm-table-cell text-nowrap">${row.scanned_at ? escapeHtml(formatTimestamp(row.scanned_at)) : '<span class="text-secondary">—</span>'}</td>
        <td class="text-end">${correctable ? `<button type="button" class="btn btn-sm btn-light border" data-correct="${escapeHtml(row.student_id)}"><i class="bi bi-pencil me-1" aria-hidden="true"></i>Correct</button>` : ''}</td>
      </tr>`;
  }).join('');
}

async function correctFlow(state, studentId, refresh) {
  const { session: info, students } = state.data;
  const student = students.find((row) => row.student_id === studentId);
  if (!student) return;
  const options = ['present', 'late', 'absent'];
  const current = student.status === 'not_scanned' ? 'absent' : student.status;
  const bodyHtml = `
    <div class="d-flex align-items-center gap-2 mb-3">
      <div>
        <div class="fw-semibold">${escapeHtml(`${student.first_name} ${student.last_name}`)}</div>
        <div class="small text-secondary">${escapeHtml(info.class_label)} · ${escapeHtml(formatDateShort(info.session_date))}</div>
      </div>
      <div class="ms-auto">${attendanceBadge(student.status)}</div>
    </div>
    <fieldset>
      <legend class="form-label fs-6">Change status to</legend>
      <div class="status-choice">
        ${options.map((value) => `
          <input type="radio" class="btn-check" name="status" id="cs_${value}" value="${value}" ${value === current ? 'disabled' : ''} required>
          <label class="btn btn-outline-${ATTENDANCE_STATUS[value].tone}" for="cs_${value}"><i class="bi bi-${ATTENDANCE_STATUS[value].icon} me-1" aria-hidden="true"></i>${ATTENDANCE_STATUS[value].label}</label>`).join('')}
      </div>
      <div class="invalid-feedback d-block" data-error-for="status"></div>
    </fieldset>
    <label class="form-label mt-3" for="cs_reason">Reason</label>
    <textarea class="form-control" id="cs_reason" name="reason" rows="2" maxlength="500" minlength="5" required placeholder="e.g. Card not read by the device; student was in class"></textarea>
    <div class="invalid-feedback" data-error-for="reason"></div>
    <p class="small text-secondary mt-2 mb-0"><i class="bi bi-shield-check me-1" aria-hidden="true"></i>The change and your reason are saved in the audit log.</p>
    ${student.corrected ? `<p class="small text-secondary mt-1 mb-0">Last correction: ${escapeHtml(student.correction_reason)}</p>` : ''}`;

  const result = await openFormModal({
    title: 'Correct attendance',
    bodyHtml,
    submitLabel: 'Save correction',
    onSubmit: (values) => callApi('instructor.correctAttendance', {
      session_id: info.session_id, student_id: studentId, status: values.status, reason: values.reason,
    }),
  });
  if (result) {
    showToast(`${student.first_name} ${student.last_name} marked ${ATTENDANCE_STATUS[result.status].label.toLowerCase()}.`);
    refresh();
  }
}
