import { callApi } from '../api.js';
import { requireRole } from '../auth.js';
import {
  renderShell, escapeHtml, formatClockTime, formatTimestamp, stateHtml, errorStateHtml,
} from '../ui.js';
import {
  attendanceBadge, formatDateShort, formatRate, rateMeterHtml, getParam, setParams,
} from '../components/attendance-ui.js';

const session = requireRole('student');
if (session) start();

function start() {
  const content = renderShell({ role: 'student', active: 'history', title: 'Attendance History', session });
  const state = { classId: getParam('class'), status: getParam('status') || 'all', data: null };
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
          <div class="col-12 col-md-6">
            <label class="form-label small text-secondary mb-1" for="classSelect">Subject</label>
            <select class="form-select" id="classSelect"><option value="">All subjects</option></select>
          </div>
          <div class="col-12 col-md-6">
            <span class="form-label small text-secondary mb-1 d-block" id="statusLabel">Status</span>
            <div class="btn-group w-100" role="group" aria-labelledby="statusLabel" id="statusGroup">
              ${[['all', 'All'], ['present', 'Present'], ['late', 'Late'], ['absent', 'Absent']].map(([value, label]) => `
                <input type="radio" class="btn-check" name="status" id="st_${value}" value="${value}"${state.status === value ? ' checked' : ''}>
                <label class="btn btn-outline-secondary" for="st_${value}">${label}</label>`).join('')}
            </div>
          </div>
        </form>
      </div>
    </div>
    <div id="historyBody"></div>`;

  const classSelect = document.getElementById('classSelect');
  const body = document.getElementById('historyBody');

  const render = () => {
    setParams({ class: state.classId, status: state.status === 'all' ? '' : state.status });
    body.innerHTML = historyHtml(state);
  };

  const load = async () => {
    const requestId = ++requestCounter;
    if (!body.children.length) {
      body.innerHTML = `<div class="card"><div class="card-body">${[1, 2, 3, 4, 5, 6].map(() => '<div class="skeleton mb-2" style="height:44px"></div>').join('')}</div></div>`;
    }
    try {
      const data = await callApi('student.getHistory', { class_id: state.classId });
      if (requestId !== requestCounter) return;
      if (classSelect.options.length === 1) {
        classSelect.insertAdjacentHTML('beforeend', data.classes.map((c) => `<option value="${escapeHtml(c.class_id)}">${escapeHtml(`${c.class_label} — ${c.subject_title}`)}</option>`).join(''));
      }
      classSelect.value = state.classId;
      state.data = data;
      render();
    } catch (error) {
      if (requestId !== requestCounter) return;
      if (error.code === 'NOT_SIGNED_IN') return void requireRole('student');
      if (error.code === 'FORBIDDEN' && state.classId) {
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
  document.getElementById('statusGroup').addEventListener('change', (event) => {
    state.status = event.target.value;
    if (state.data) render();
  });
  document.getElementById('filterForm').addEventListener('submit', (event) => event.preventDefault());

  load();
}

function historyHtml(state) {
  const { records, totals } = state.data;
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
    return `${summary}<div class="card">${stateHtml({ icon: 'search', title: 'No records to show', message: records.length ? 'Try another status filter.' : 'Records appear after your first class session.' })}</div>`;
  }

  const note = (row) => {
    if (row.corrected) return '<span class="badge text-bg-light border ms-1" title="Updated by your instructor">Corrected</span>';
    if (row.manual) return '<span class="badge text-bg-light border ms-1">Manual</span>';
    return '';
  };

  return `
    ${summary}
    <div class="card">
      <div class="card-header border-bottom">
        <h3 class="card-title-sm">Sessions</h3>
        <span class="small text-secondary">${rows.length} record${rows.length === 1 ? '' : 's'}</span>
      </div>
      <div class="table-responsive d-none d-md-block">
        <table class="table table-hover align-middle mb-0">
          <thead><tr><th>Date</th><th>Subject</th><th>Class time</th><th>Room</th><th>Time in</th><th>Status</th></tr></thead>
          <tbody>
            ${rows.map((row) => `
              <tr>
                <td class="text-nowrap">${escapeHtml(formatDateShort(row.session_date))}</td>
                <td><div class="cell-main">${escapeHtml(row.class_label)}</div><div class="cell-sub">${escapeHtml(row.subject_title)}</div></td>
                <td class="text-nowrap">${formatClockTime(row.start_time)}–${formatClockTime(row.end_time)}</td>
                <td>${escapeHtml(row.room_code)}</td>
                <td class="text-nowrap">${row.scanned_at ? escapeHtml(formatTimestamp(row.scanned_at)) : '<span class="text-secondary">—</span>'}</td>
                <td class="text-nowrap">${attendanceBadge(row.status)}${note(row)}</td>
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
          </div>`).join('')}
      </div>
    </div>`;
}
