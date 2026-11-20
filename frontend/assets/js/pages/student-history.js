import { callApi } from '../api.js';
import { requireRole } from '../auth.js';
import {
  renderShell, escapeHtml, formatClockTime, formatTimestamp, formatDateTime, stateHtml, errorStateHtml,
  showFieldErrors, showToast,
} from '../ui.js';
import {
  attendanceBadge, formatDateShort, formatRate, rateMeterHtml, getParam, setParams,
  rangeInputsHtml, dateFieldErrors, rangeText,
} from '../components/attendance-ui.js';

const session = requireRole('student');
if (session) start();

function start() {
  const content = renderShell({ role: 'student', active: 'history', title: 'Attendance History', session });
  const state = {
    classId: getParam('class'), status: getParam('status') || 'all', from: getParam('from'), to: getParam('to'), data: null,
  };
  let requestCounter = 0;

  content.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">Attendance history</h2>
        <p class="page-subtitle">Every class session you were enrolled in, newest first.</p>
      </div>
    </div>
    <div class="card mb-3">
      <div class="card-body">
        <form class="row g-2 align-items-end" id="filterForm">
          <div class="col-12 col-lg-4">
            <label class="form-label small text-secondary mb-1" for="classSelect">Subject</label>
            <select class="form-select" id="classSelect"><option value="">All subjects</option></select>
          </div>
          ${rangeInputsHtml(state)}
          <div class="col-12">
            <span class="form-label small text-secondary mb-1 d-block" id="statusLabel">Status</span>
            <div class="btn-group w-100" role="group" aria-labelledby="statusLabel" id="statusGroup">${statusButtonsHtml(state)}</div>
          </div>
        </form>
      </div>
    </div>
    <div id="historyBody"></div>`;

  const form = document.getElementById('filterForm');
  const classSelect = document.getElementById('classSelect');
  const statusGroup = document.getElementById('statusGroup');
  const body = document.getElementById('historyBody');

  const render = () => {
    statusGroup.innerHTML = statusButtonsHtml(state);
    if (!statusGroup.querySelector(':checked')) {
      state.status = 'all'; // e.g. "Not yet" kept after those rows became absent
      statusGroup.innerHTML = statusButtonsHtml(state);
    }
    setParams({ class: state.classId, status: state.status === 'all' ? '' : state.status, from: state.from, to: state.to });
    body.innerHTML = historyHtml(state);
  };

  const load = async () => {
    const requestId = ++requestCounter;
    if (!body.children.length) {
      body.innerHTML = `<div class="card"><div class="card-body">${[1, 2, 3, 4, 5, 6].map(() => '<div class="skeleton mb-2" style="height:44px"></div>').join('')}</div></div>`;
    }
    try {
      const data = await callApi('student.getHistory', { class_id: state.classId, from: state.from, to: state.to });
      if (requestId !== requestCounter) return;
      showFieldErrors(form, {});
      if (classSelect.options.length === 1) {
        classSelect.insertAdjacentHTML('beforeend', data.classes.map((c) => `<option value="${escapeHtml(c.class_id)}">${escapeHtml(`${c.class_label} — ${c.subject_title}`)}</option>`).join(''));
      }
      classSelect.value = state.classId;
      state.data = data;
      render();
    } catch (error) {
      if (requestId !== requestCounter) return;
      const dateErrors = dateFieldErrors(error);
      if (dateErrors) {
        showFieldErrors(form, dateErrors);
        state.data = null; // a status click must not bring back the old rows
        body.innerHTML = `<div class="card">${stateHtml({ icon: 'calendar-x', title: 'Check the dates', message: 'Fix the date range above, or choose “Whole term”.' })}</div>`;
        return;
      }
      if (error.code === 'FORBIDDEN' && state.classId) {
        showToast('You are not enrolled in that subject. Showing all your subjects.', 'warning');
        state.classId = '';
        load();
        return;
      }
      body.innerHTML = `<div class="card">${errorStateHtml(error.message)}</div>`;
      body.querySelector('[data-action="retry"]').addEventListener('click', load);
    }
  };

  classSelect.addEventListener('change', () => {
    state.classId = classSelect.value;
    load();
  });
  statusGroup.addEventListener('change', (event) => {
    state.status = event.target.value;
    if (state.data) render();
  });
  const fromDate = document.getElementById('fromDate');
  const toDate = document.getElementById('toDate');
  [fromDate, toDate].forEach((input) => input.addEventListener('change', () => {
    state.from = fromDate.value;
    state.to = toDate.value;
    load();
  }));
  form.querySelector('[data-range-clear]').addEventListener('click', () => {
    fromDate.value = '';
    toDate.value = '';
    state.from = '';
    state.to = '';
    load();
  });
  form.addEventListener('submit', (event) => event.preventDefault());

  load();
}

// "Not yet" only when a record has it (a class still running today).
function statusButtonsHtml(state) {
  const notYet = state.data?.records.some((row) => row.status === 'not_scanned');
  return [['all', 'All'], ['present', 'Present'], ['late', 'Late'], ...(notYet ? [['not_scanned', 'Not yet']] : []), ['absent', 'Absent']]
    .map(([value, label]) => `
      <input type="radio" class="btn-check" name="status" id="st_${value}" value="${value}"${state.status === value ? ' checked' : ''}>
      <label class="btn btn-outline-secondary" for="st_${value}">${label}</label>`).join('');
}

// Who (role only), when and why a record was corrected.
function correctionHtml(row) {
  const c = row.correction;
  if (!c) return '';
  const who = c.by_role ? `Corrected by ${c.by_role}` : 'Corrected';
  return `<div class="cell-sub text-wrap">${escapeHtml(`${who}${c.at ? ` · ${formatDateTime(c.at)}` : ''}: ${c.reason}`)}</div>`;
}

function historyHtml(state) {
  const { records, totals, range } = state.data;
  const rows = records.filter((row) => state.status === 'all' || row.status === state.status);

  const summary = `
    <div class="card mb-3">
      <div class="card-body">
        <div class="row g-2 text-center summary-tiles">
          <div class="col-6 col-md-3"><div class="summary-tile"><div class="summary-num">${formatRate(totals.rate)}</div><div class="summary-label">Attendance</div></div></div>
          <div class="col-6 col-md-3"><div class="summary-tile tone-success"><div class="summary-num">${totals.present}</div><div class="summary-label">Present</div></div></div>
          <div class="col-6 col-md-3"><div class="summary-tile tone-warning"><div class="summary-num">${totals.late}</div><div class="summary-label">Late</div></div></div>
          <div class="col-6 col-md-3"><div class="summary-tile tone-danger"><div class="summary-num">${totals.absent}</div><div class="summary-label">Absent</div></div></div>
        </div>
        ${rateMeterHtml(totals.rate)}
      </div>
    </div>`;

  if (!rows.length) {
    const ranged = Boolean(range?.from || range?.to);
    const message = records.length ? 'Try another status filter.' : (ranged ? 'No class sessions in this date range.' : 'Records appear after your first class session.');
    return `${summary}<div class="card">${stateHtml({ icon: 'search', title: 'No records to show', message })}</div>`;
  }

  const note = (row) => {
    if (row.corrected) return '<span class="badge text-bg-light border ms-1">Corrected</span>';
    if (row.manual) return '<span class="badge text-bg-light border ms-1">Manual</span>';
    return '';
  };

  return `
    ${summary}
    <div class="card">
      <div class="card-header border-bottom">
        <h3 class="card-title-sm">Sessions</h3>
        <span class="small text-secondary">${rows.length} record${rows.length === 1 ? '' : 's'} · ${escapeHtml(rangeText(range))}</span>
      </div>
      <div class="table-responsive d-none d-md-block">
        <table class="table table-hover align-middle mb-0">
          <thead><tr><th>Date</th><th>Subject</th><th>Class time</th><th>Room</th><th>Time in</th><th>Status</th></tr></thead>
          <tbody>
            ${rows.map((row) => `
              <tr>
                <td class="text-nowrap">${escapeHtml(formatDateShort(row.session_date))}</td>
                <td><div class="cell-main">${escapeHtml(row.class_label)}</div><div class="cell-sub">${escapeHtml(row.subject_title)}</div></td>
                <td class="text-nowrap">${escapeHtml(formatClockTime(row.start_time))}–${escapeHtml(formatClockTime(row.end_time))}</td>
                <td>${escapeHtml(row.room_code)}</td>
                <td class="text-nowrap">${row.scanned_at ? escapeHtml(formatTimestamp(row.scanned_at)) : '<span class="text-secondary">—</span>'}</td>
                <td><span class="text-nowrap">${attendanceBadge(row.status)}${note(row)}</span>${correctionHtml(row)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="d-md-none">
        ${rows.map((row) => `
          <div class="session-item">
            <div class="d-flex justify-content-between align-items-start gap-2">
              <div class="min-w-0">
                <div class="cell-main">${escapeHtml(row.class_label)}</div>
                <div class="cell-sub">${escapeHtml(formatDateShort(row.session_date))} · ${formatClockTime(row.start_time)} · ${escapeHtml(row.room_code)}${row.scanned_at ? ` · in ${escapeHtml(formatTimestamp(row.scanned_at))}` : ''}</div>
              </div>
              <div class="text-nowrap">${attendanceBadge(row.status)}${note(row)}</div>
            </div>
            ${correctionHtml(row)}
          </div>`).join('')}
      </div>
    </div>`;
}
