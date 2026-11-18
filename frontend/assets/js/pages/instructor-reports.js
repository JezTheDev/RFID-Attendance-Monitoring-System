import { callApi } from '../api.js';
import { requireRole } from '../auth.js';
import {
  renderShell, escapeHtml, formatDateTime, stateHtml, errorStateHtml, showToast,
} from '../ui.js';
import {
  statCard, formatRate, rateMeterHtml, rateTone, formatDateShort, getParam, setParams, downloadCsv, scheduleText,
} from '../components/attendance-ui.js';
import { openStudentHistory } from './instructor-history.js';

const MARK = {
  present: { letter: 'P', tone: 'success', label: 'Present' },
  late: { letter: 'L', tone: 'warning', label: 'Late' },
  absent: { letter: 'A', tone: 'danger', label: 'Absent' },
  not_scanned: { letter: '·', tone: 'secondary', label: 'Not scanned yet' },
};

const session = requireRole('instructor');
if (session) start();

function start() {
  const content = renderShell({ role: 'instructor', active: 'reports', title: 'Class Reports', session });
  const state = { classId: getParam('class'), from: getParam('from'), to: getParam('to'), data: null };
  let requestCounter = 0;

  content.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">Class attendance report</h2>
        <p class="page-subtitle">Summary per student for the sessions in the chosen date range.</p>
      </div>
      <div class="d-flex gap-2 d-print-none">
        <button type="button" class="btn btn-light border" id="printButton" disabled><i class="bi bi-printer me-1" aria-hidden="true"></i>Print</button>
        <button type="button" class="btn btn-primary" id="exportButton" disabled><i class="bi bi-download me-1" aria-hidden="true"></i>Export CSV</button>
      </div>
    </div>
    <div class="card mb-3 d-print-none">
      <div class="card-body">
        <form class="row g-2 align-items-end" id="reportForm" novalidate>
          <div class="col-12 col-lg-4">
            <label class="form-label small text-secondary mb-1" for="classSelect">Class</label>
            <select class="form-select" id="classSelect"><option value="">Loading…</option></select>
          </div>
          <div class="col-6 col-lg-3">
            <label class="form-label small text-secondary mb-1" for="fromDate">From</label>
            <input type="date" class="form-control" id="fromDate" value="${escapeHtml(state.from)}">
          </div>
          <div class="col-6 col-lg-3">
            <label class="form-label small text-secondary mb-1" for="toDate">To</label>
            <input type="date" class="form-control" id="toDate" value="${escapeHtml(state.to)}">
          </div>
          <div class="col-12 col-lg-2 d-grid">
            <button type="button" class="btn btn-light border" id="wholeTerm">Whole term</button>
          </div>
        </form>
      </div>
    </div>
    <div id="reportBody"></div>`;

  const classSelect = document.getElementById('classSelect');
  const fromDate = document.getElementById('fromDate');
  const toDate = document.getElementById('toDate');
  const body = document.getElementById('reportBody');
  const exportButton = document.getElementById('exportButton');
  const printButton = document.getElementById('printButton');

  const load = async () => {
    const requestId = ++requestCounter;
    exportButton.disabled = true;
    printButton.disabled = true;
    if (!body.children.length) {
      body.innerHTML = `<div class="row g-3 mb-3">${[1, 2, 3, 4].map(() => '<div class="col-6 col-xl-3"><div class="skeleton" style="height:96px"></div></div>').join('')}</div><div class="skeleton" style="height:360px"></div>`;
    }
    try {
      const data = await callApi('instructor.getClassReport', { class_id: state.classId, from: state.from, to: state.to });
      if (requestId !== requestCounter) return;
      if (!state.classId && data.classes.length) {
        state.classId = data.classes[0].class_id;
        load();
        return;
      }
      classSelect.innerHTML = data.classes.length
        ? data.classes.map((c) => `<option value="${escapeHtml(c.class_id)}"${c.class_id === state.classId ? ' selected' : ''}>${escapeHtml(c.class_label)}</option>`).join('')
        : '<option value="">No classes assigned</option>';
      setParams({ class: state.classId, from: state.from, to: state.to });
      state.data = data;
      if (!data.class) {
        body.innerHTML = `<div class="card">${stateHtml({ icon: 'journal-x', title: 'No classes assigned', message: 'Reports appear once a class is assigned to you.' })}</div>`;
        return;
      }
      body.innerHTML = reportHtml(data);
      exportButton.disabled = !data.students.length;
      printButton.disabled = false;
    } catch (error) {
      if (requestId !== requestCounter) return;
      if (error.code === 'NOT_SIGNED_IN') return void requireRole('instructor');
      if (error.fields?.to) {
        showToast(error.fields.to, 'warning');
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
  [fromDate, toDate].forEach((input) => input.addEventListener('change', () => {
    state.from = fromDate.value;
    state.to = toDate.value;
    load();
  }));
  document.getElementById('wholeTerm').addEventListener('click', () => {
    fromDate.value = '';
    toDate.value = '';
    state.from = '';
    state.to = '';
    load();
  });
  document.getElementById('reportForm').addEventListener('submit', (event) => event.preventDefault());
  exportButton.addEventListener('click', () => exportCsv(state.data));
  printButton.addEventListener('click', () => window.print());
  body.addEventListener('click', (event) => {
    const history = event.target.closest('[data-history]');
    if (history) openStudentHistory(state.classId, history.dataset.history);
  });

  load();
}

function rangeText(range) {
  if (!range.from && !range.to) return 'Whole term';
  if (range.from && range.to) return `${formatDateShort(range.from)} – ${formatDateShort(range.to)}`;
  return range.from ? `From ${formatDateShort(range.from)}` : `Up to ${formatDateShort(range.to)}`;
}

function reportHtml(data) {
  const { class: klass, students, sessions, totals } = data;
  const perfect = students.filter((row) => row.total > 0 && row.absent === 0 && row.late === 0).length;
  const atRisk = students.filter((row) => row.rate !== null && row.rate < 0.8).length;

  const header = `
    <div class="report-head card mb-3">
      <div class="card-body d-flex flex-wrap justify-content-between gap-3">
        <div class="min-w-0">
          <div class="class-card-code">${escapeHtml(klass.subject_code)} · ${escapeHtml(klass.section_label)}</div>
          <div class="fs-5 fw-semibold">${escapeHtml(klass.subject_title)}</div>
          <div class="small text-secondary">${escapeHtml(scheduleText(klass.schedules))}</div>
        </div>
        <div class="small text-md-end">
          <div><span class="text-secondary">Instructor:</span> ${escapeHtml(klass.instructor_name)}</div>
          <div><span class="text-secondary">Range:</span> ${escapeHtml(rangeText(data.range))}</div>
          <div><span class="text-secondary">Generated:</span> ${escapeHtml(formatDateTime(data.generated_at))}</div>
        </div>
      </div>
    </div>`;

  const stats = `
    <div class="row g-3 mb-3">
      ${statCard({ icon: 'calendar-check', label: 'Sessions held', value: sessions.length, hint: data.cancelled_sessions ? `${data.cancelled_sessions} cancelled (not counted)` : 'Completed class sessions' })}
      ${statCard({ icon: 'graph-up', label: 'Class attendance', value: formatRate(totals.rate), hint: `${totals.present} present · ${totals.late} late · ${totals.absent} absent`, gold: true })}
      ${statCard({ icon: 'award', label: 'Perfect attendance', value: perfect, hint: `of ${students.length} students` })}
      ${statCard({ icon: 'person-exclamation', label: 'Below 80%', value: atRisk, hint: 'Students needing follow-up', gold: true })}
    </div>`;

  if (!sessions.length) {
    return `${header}${stats}<div class="card">${stateHtml({ icon: 'calendar', title: 'No sessions in this range', message: 'Choose a wider date range or “Whole term”.' })}</div>`;
  }

  const summary = `
    <div class="card mb-3">
      <div class="card-header border-bottom">
        <h3 class="card-title-sm">Per-student summary</h3>
        <span class="small text-secondary">${students.length} students</span>
      </div>
      <div class="table-responsive">
        <table class="table table-hover align-middle mb-0">
          <thead><tr><th>Student</th><th class="num">Present</th><th class="num">Late</th><th class="num">Absent</th><th style="min-width:150px">Rate</th></tr></thead>
          <tbody>
            ${students.map((row) => `
              <tr>
                <td>
                  <button type="button" class="btn btn-link p-0 text-start text-decoration-none cell-main" data-history="${escapeHtml(row.student_id)}">${escapeHtml(`${row.last_name}, ${row.first_name}`)}</button>
                  <div class="cell-sub">${escapeHtml(row.student_number)}</div>
                </td>
                <td class="num">${row.present}</td>
                <td class="num">${row.late}</td>
                <td class="num">${row.absent}</td>
                <td>
                  <div class="d-flex align-items-center gap-2">
                    <span class="fw-semibold text-${rateTone(row.rate)}-emphasis text-end" style="min-width:4.5ch">${formatRate(row.rate)}</span>
                    <div class="flex-grow-1">${rateMeterHtml(row.rate)}</div>
                  </div>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;

  const matrix = `
    <div class="card">
      <div class="card-header border-bottom flex-wrap gap-2">
        <h3 class="card-title-sm">Session by session</h3>
        <span class="small text-secondary d-flex gap-3">
          ${['present', 'late', 'absent'].map((key) => `<span><span class="mark mark-${MARK[key].tone}">${MARK[key].letter}</span> ${MARK[key].label}</span>`).join('')}
        </span>
      </div>
      <div class="table-responsive">
        <table class="table table-sm align-middle mb-0 matrix-table">
          <thead>
            <tr>
              <th class="matrix-sticky">Student</th>
              ${sessions.map((s) => {
                const [, m, d] = s.session_date.split('-');
                return `<th class="text-center" title="${escapeHtml(formatDateShort(s.session_date))}">${Number(m)}/${Number(d)}</th>`;
              }).join('')}
            </tr>
          </thead>
          <tbody>
            ${students.map((row) => `
              <tr>
                <td class="matrix-sticky text-nowrap">${escapeHtml(`${row.last_name}, ${row.first_name}`)}</td>
                ${row.marks.map((mark, i) => `<td class="text-center"><span class="mark mark-${MARK[mark].tone}" title="${escapeHtml(`${formatDateShort(sessions[i].session_date)}: ${MARK[mark].label}`)}">${MARK[mark].letter}</span></td>`).join('')}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;

  return header + stats + summary + matrix;
}

function exportCsv(data) {
  if (!data?.class) return;
  const { class: klass, sessions, students } = data;
  const rows = [
    ['Class', klass.class_label],
    ['Subject', `${klass.subject_code} ${klass.subject_title}`],
    ['Instructor', klass.instructor_name],
    ['Range', rangeText(data.range)],
    ['Generated', formatDateTime(data.generated_at)],
    [],
    ['Student number', 'Last name', 'First name', ...sessions.map((s) => s.session_date), 'Present', 'Late', 'Absent', 'Attendance rate'],
    ...students.map((row) => [
      row.student_number, row.last_name, row.first_name,
      ...row.marks.map((mark) => MARK[mark].letter),
      row.present, row.late, row.absent, formatRate(row.rate),
    ]),
  ];
  const range = data.range.from || data.range.to ? `_${data.range.from || 'start'}_to_${data.range.to || 'end'}` : '_whole-term';
  downloadCsv(`${klass.class_label.replace(/[^A-Za-z0-9]+/g, '-')}${range}.csv`, rows);
  showToast('Report downloaded as CSV.');
}
