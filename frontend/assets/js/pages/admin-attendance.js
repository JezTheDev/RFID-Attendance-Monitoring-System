import { callApi } from '../api.js';
import { requireRole } from '../auth.js';
import {
  renderShell, escapeHtml, formatDateTime, formatTimestamp, formatClockTime, todayInManila,
  stateHtml, errorStateHtml, openFormModal, showFieldErrors, showToast,
} from '../ui.js';
import {
  attendanceBadge, formatRate, formatDateShort, downloadCsv,
} from '../components/attendance-ui.js';

const PAGE_SIZE = 100;
const EXPORT_PAGE_SIZE = 500; // backend maximum
const STATUS_OPTIONS = [['present', 'Present'], ['late', 'Late'], ['absent', 'Absent']];
const GROUP_LABEL = { class: 'Class', section: 'Section', student: 'Student' };

const session = requireRole('admin');
if (session) start();

function start() {
  const content = renderShell({ role: 'admin', active: 'attendance', title: 'Attendance', session });
  content.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">Attendance</h2>
        <p class="page-subtitle">Every attendance record, corrections, and attendance reports for all classes.</p>
      </div>
    </div>
    <div class="tab-scroll mb-3">
      <ul class="nav nav-pills flex-nowrap" role="tablist">
        <li class="nav-item" role="presentation"><button class="nav-link" type="button" role="tab" id="tab-records" data-tab="records" aria-controls="panel-records">Records</button></li>
        <li class="nav-item" role="presentation"><button class="nav-link" type="button" role="tab" id="tab-reports" data-tab="reports" aria-controls="panel-reports">Reports</button></li>
      </ul>
    </div>
    <section role="tabpanel" id="panel-records" aria-labelledby="tab-records" class="d-none"></section>
    <section role="tabpanel" id="panel-reports" aria-labelledby="tab-reports" class="d-none"></section>`;

  // Class and section lists for the filters (shared by both tabs).
  const options = Promise.all([callApi('admin.listClasses', {}), callApi('admin.getClassOptions')])
    .then(([classes, classOptions]) => ({
      classes: classes.items.map((row) => ({ value: row.class_id, label: row.class_label })),
      sections: classOptions.sections,
    }));

  const mounted = {};
  const show = (key) => {
    const tab = key === 'reports' ? 'reports' : 'records';
    ['records', 'reports'].forEach((name) => {
      const button = document.getElementById(`tab-${name}`);
      button.classList.toggle('active', name === tab);
      button.setAttribute('aria-selected', String(name === tab));
      document.getElementById(`panel-${name}`).classList.toggle('d-none', name !== tab);
    });
    if (!mounted[tab]) mounted[tab] = (tab === 'records' ? mountRecords : mountReports)(document.getElementById(`panel-${tab}`), options);
    if (window.location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
  };
  content.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => show(button.dataset.tab)));
  show(window.location.hash.slice(1));
}

// ---------- shared filter bits ----------

function selectHtml(name, label, items, allLabel) {
  return `
    <div class="col-6 col-md-4 col-xl-2">
      <label class="form-label small mb-1" for="f_${name}">${escapeHtml(label)}</label>
      <select class="form-select form-select-sm" id="f_${name}" name="${name}">
        <option value="">${escapeHtml(allLabel)}</option>
        ${items.map(([value, text]) => `<option value="${escapeHtml(value)}">${escapeHtml(text)}</option>`).join('')}
      </select>
      <div class="invalid-feedback" data-error-for="${name}"></div>
    </div>`;
}

function dateHtml(name, label) {
  return `
    <div class="col-6 col-md-4 col-xl-2">
      <label class="form-label small mb-1" for="f_${name}">${escapeHtml(label)}</label>
      <input type="date" class="form-control form-control-sm" id="f_${name}" name="${name}">
      <div class="invalid-feedback" data-error-for="${name}"></div>
    </div>`;
}

async function fillOptions(form, options) {
  try {
    const { classes, sections } = await options;
    const add = (name, items) => form.elements.namedItem(name)?.insertAdjacentHTML('beforeend',
      items.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join(''));
    add('class_id', classes);
    add('section_id', sections);
  } catch (error) {
    showToast(`Could not load the class and section lists: ${error.message}`, 'danger');
  }
}

const loadingRows = () => `<div class="card-body">${[1, 2, 3, 4].map(() => '<div class="skeleton mb-2" style="height:44px"></div>').join('')}</div>`;

// ---------- Records ----------

function mountRecords(panel, options) {
  panel.innerHTML = `
    <form class="card card-body mb-3" id="recordsFilter" novalidate>
      <div class="row g-2 align-items-end">
        ${dateHtml('from', 'From')}
        ${dateHtml('to', 'To')}
        ${selectHtml('class_id', 'Class', [], 'All classes')}
        ${selectHtml('section_id', 'Section', [], 'All sections')}
        <div class="col-6 col-md-4 col-xl-2">
          <label class="form-label small mb-1" for="f_student">Student number</label>
          <input type="text" class="form-control form-control-sm" id="f_student" name="student" inputmode="numeric" autocomplete="off" placeholder="Any student">
          <div class="invalid-feedback" data-error-for="student"></div>
        </div>
        ${selectHtml('status', 'Status', STATUS_OPTIONS, 'Any status')}
      </div>
      <div class="d-flex flex-wrap gap-2 mt-3">
        <button type="submit" class="btn btn-primary btn-sm"><i class="bi bi-funnel me-1" aria-hidden="true"></i>Apply filters</button>
        <button type="reset" class="btn btn-light border btn-sm">Clear</button>
        <span class="flex-grow-1"></span>
        <button type="button" class="btn btn-outline-primary btn-sm" id="addMissing"><i class="bi bi-person-plus me-1" aria-hidden="true"></i>Student without a tap</button>
        <button type="button" class="btn btn-outline-secondary btn-sm" id="exportRecords"><i class="bi bi-download me-1" aria-hidden="true"></i>Export CSV</button>
      </div>
      <div class="small text-secondary mt-2" id="exportNote" role="status" aria-live="polite"></div>
    </form>
    <div class="card" id="recordsList" aria-live="polite"></div>`;

  const form = panel.querySelector('#recordsFilter');
  const list = panel.querySelector('#recordsList');
  const state = { filters: {}, page: 1, request: 0, rows: [] };
  fillOptions(form, options);

  // The student filter takes a student number; the API needs the student_id.
  const studentIdFor = async (number) => {
    if (!number) return '';
    const found = await callApi('admin.listStudents', { search: number, status: 'all', page: 1, page_size: 10 });
    const match = found.items.find((s) => s.student_number === number);
    if (!match) throw Object.assign(new Error('No student has this student number.'), { fields: { student: 'No student has this student number.' } });
    return match.student_id;
  };

  const readFilters = async () => {
    const values = Object.fromEntries(new FormData(form));
    return {
      from: values.from, to: values.to, class_id: values.class_id, section_id: values.section_id,
      student_id: await studentIdFor(values.student.trim()), status: values.status,
    };
  };

  const load = async () => {
    const requestId = ++state.request;
    list.setAttribute('aria-busy', 'true');
    if (!list.querySelector('table')) list.innerHTML = loadingRows();
    try {
      const data = await callApi('admin.listAttendance', { ...state.filters, page: state.page, page_size: PAGE_SIZE });
      if (requestId !== state.request) return;
      showFieldErrors(form, {});
      state.rows = data.rows;
      list.innerHTML = recordsHtml(data);
    } catch (error) {
      if (requestId !== state.request) return;
      showFieldErrors(form, error.fields ?? {});
      list.innerHTML = errorStateHtml(error.message);
      list.querySelector('[data-action="retry"]').addEventListener('click', load);
    } finally {
      if (requestId === state.request) list.removeAttribute('aria-busy');
    }
  };

  const apply = async () => {
    showFieldErrors(form, {});
    list.setAttribute('aria-busy', 'true'); // the student-number lookup comes first
    try {
      state.filters = await readFilters();
    } catch (error) {
      list.removeAttribute('aria-busy');
      showFieldErrors(form, error.fields ?? {});
      if (!error.fields) list.innerHTML = errorStateHtml(error.message);
      return;
    }
    state.page = 1;
    load();
  };

  form.addEventListener('submit', (event) => { event.preventDefault(); apply(); });
  form.addEventListener('reset', () => setTimeout(apply));
  list.addEventListener('click', (event) => {
    const pager = event.target.closest('[data-page]');
    if (pager) {
      state.page = Number(pager.dataset.page);
      load();
      return;
    }
    const fix = event.target.closest('[data-correct]');
    const row = fix && state.rows.find((r) => r.attendance_id === fix.dataset.correct);
    if (row) correctFlow(row, load);
  });
  panel.querySelector('#addMissing').addEventListener('click', () => missingTapFlow(load));
  panel.querySelector('#exportRecords').addEventListener('click', (event) => exportRecords(event.currentTarget, state.filters, panel.querySelector('#exportNote')));

  apply();
  return { reload: load };
}

function recordsHtml(data) {
  if (!data.rows.length) {
    return stateHtml({ icon: 'clipboard-x', title: data.total ? 'No records on this page' : 'No attendance records', message: 'Try another date range or filter.' });
  }
  const pages = Math.max(1, Math.ceil(data.total / data.page_size));
  const first = (data.page - 1) * data.page_size + 1;
  const last = first + data.rows.length - 1;
  return `
    <div class="table-responsive">
      <table class="table table-hover align-middle mb-0">
        <thead><tr>
          <th>Date</th><th>Class</th><th>Student</th><th>Scanned at</th><th>Status</th>
          <th class="d-none d-lg-table-cell">Source</th><th class="d-none d-xl-table-cell">Correction</th>
          <th class="text-end"><span class="visually-hidden">Actions</span></th>
        </tr></thead>
        <tbody>
          ${data.rows.map((row) => `
            <tr>
              <td class="text-nowrap">${escapeHtml(formatDateShort(row.session_date))}</td>
              <td><div class="cell-main">${escapeHtml(row.class_label)}</div><div class="cell-sub">${escapeHtml(row.room_code)}</div></td>
              <td><div class="cell-main">${escapeHtml(row.student_name)}</div><div class="cell-sub font-monospace">${escapeHtml(row.student_number)}</div></td>
              <td class="text-nowrap">${escapeHtml(formatTimestamp(row.scanned_at))}</td>
              <td>${attendanceBadge(row.status)}${row.corrected ? `<div class="cell-sub mt-1">Device: ${escapeHtml(row.device_status)}</div>` : ''}</td>
              <td class="d-none d-lg-table-cell small">${sourceText(row)}</td>
              <td class="d-none d-xl-table-cell small">${correctionHtml(row)}</td>
              <td class="text-end"><button type="button" class="btn btn-sm btn-light border text-nowrap" data-correct="${escapeHtml(row.attendance_id)}"><i class="bi bi-pencil-square me-1" aria-hidden="true"></i>Correct</button></td>
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

function sourceText(row) {
  if (row.source === 'manual') return 'Manual';
  return row.sync_mode === 'offline'
    ? 'Device · <span class="text-warning-emphasis"><i class="bi bi-cloud-arrow-up me-1" aria-hidden="true"></i>synced later</span>'
    : 'Device · live';
}

function correctionHtml(row) {
  if (row.corrected) {
    return `${escapeHtml(row.override_by_name || row.override_by)} · ${escapeHtml(formatDateTime(row.override_at))}<div class="cell-sub">${escapeHtml(row.override_reason)}</div>`;
  }
  // A manual row is itself a correction: its reason is kept on the row.
  return row.source === 'manual' && row.override_reason
    ? `<div class="cell-sub">${escapeHtml(row.override_reason)}</div>`
    : '<span class="text-secondary">—</span>';
}

function statusFields(current = '') {
  return `
    <label class="form-label" for="c_status">New status</label>
    <select class="form-select" id="c_status" name="status" required>
      <option value="">Choose…</option>
      ${STATUS_OPTIONS.map(([value, label]) => `<option value="${value}"${value === current ? ' disabled' : ''}>${label}${value === current ? ' (current)' : ''}</option>`).join('')}
    </select>
    <div class="invalid-feedback" data-error-for="status"></div>
    <label class="form-label mt-3" for="c_reason">Reason</label>
    <textarea class="form-control" id="c_reason" name="reason" rows="2" minlength="5" maxlength="500" required placeholder="e.g. Card reader was down; student was present"></textarea>
    <div class="invalid-feedback" data-error-for="reason"></div>
    <div class="form-text">Required. Kept with the record and in the audit log.</div>
    <div class="form-text">The student can see this reason.</div>`;
}

async function correctFlow(row, reload) {
  const result = await openFormModal({
    title: `Correct attendance · ${row.student_name}`,
    bodyHtml: `
      <p class="small text-secondary mb-3">${escapeHtml(row.class_label)} · ${escapeHtml(formatDateShort(row.session_date))} · now ${escapeHtml(row.status)}</p>
      ${statusFields(row.status)}`,
    submitLabel: 'Save correction',
    onSubmit: (values) => callApi('admin.correctAttendance', {
      session_id: row.session_id, student_id: row.student_id, status: values.status, reason: values.reason,
    }),
  });
  if (!result) return;
  showToast(`${row.student_name} marked ${result.status}.`);
  await reload();
}

// Enrolled student with NO attendance row: pick the day's session, then the student.
async function missingTapFlow(reload) {
  let sessions = [];
  const done = openFormModal({
    title: 'Student without a tap',
    bodyHtml: `
      <p class="small text-secondary">For an enrolled student who has no record for a session. Students without a tap count as absent automatically once the class ends.</p>
      <label class="form-label" for="m_date">Date</label>
      <input type="date" class="form-control" id="m_date" value="${escapeHtml(todayInManila())}" required>
      <label class="form-label mt-3" for="m_session">Class session</label>
      <select class="form-select" id="m_session" name="session_id" required><option value="">Choose a date first…</option></select>
      <div class="invalid-feedback" data-error-for="session_id"></div>
      <label class="form-label mt-3" for="m_student">Student</label>
      <select class="form-select" id="m_student" name="student_id" required><option value="">Choose a session first…</option></select>
      <div class="invalid-feedback" data-error-for="student_id"></div>
      <div class="mt-3">${statusFields()}</div>`,
    submitLabel: 'Save',
    onSubmit: (values) => callApi('admin.correctAttendance', values),
  });

  // openFormModal adds the dialog to the page synchronously.
  const dialog = document.getElementById('m_date').closest('form');
  const sessionSelect = dialog.querySelector('#m_session');
  const studentSelect = dialog.querySelector('#m_student');
  const setOptions = (select, items, empty) => {
    select.innerHTML = `<option value="">${escapeHtml(items.length ? 'Choose…' : empty)}</option>${items.map(([v, t]) => `<option value="${escapeHtml(v)}">${escapeHtml(t)}</option>`).join('')}`;
  };
  let latest = 0; // only the newest date / session choice may fill the selects
  const loadSessions = async () => {
    const requestId = ++latest;
    setOptions(studentSelect, [], 'Choose a session first…');
    setOptions(sessionSelect, [], 'Loading…');
    try {
      const data = await callApi('admin.getDashboard', { date: dialog.querySelector('#m_date').value });
      if (requestId !== latest) return;
      sessions = data.sessions.filter((s) => s.session_id && s.phase !== 'cancelled');
      setOptions(sessionSelect, sessions.map((s) => [s.session_id, `${formatClockTime(s.start_time)} · ${s.class_label} · ${s.room_code}`]), 'No class sessions on this date');
    } catch (error) {
      if (requestId === latest) setOptions(sessionSelect, [], `Could not load sessions: ${error.message}`);
    }
  };
  dialog.querySelector('#m_date').addEventListener('change', loadSessions);
  sessionSelect.addEventListener('change', async () => {
    const requestId = ++latest;
    const chosen = sessions.find((s) => s.session_id === sessionSelect.value);
    if (!chosen) return setOptions(studentSelect, [], 'Choose a session first…');
    setOptions(studentSelect, [], 'Loading…');
    try {
      const data = await callApi('admin.getClass', { class_id: chosen.class_id });
      if (requestId !== latest) return;
      setOptions(studentSelect, data.students.map((s) => [s.student_id, `${s.name} · ${s.student_number}`]), 'No enrolled students');
    } catch (error) {
      setOptions(studentSelect, [], `Could not load students: ${error.message}`);
    }
  });
  loadSessions();

  const result = await done;
  if (!result) return;
  showToast(`Attendance saved as ${result.status}.`);
  await reload();
}

async function exportRecords(button, filters, note) {
  button.disabled = true;
  const rows = [];
  try {
    let page = 1;
    let total = 0;
    do {
      note.textContent = `Fetching records… ${rows.length}${total ? ` of ${total}` : ''}`;
      // eslint-disable-next-line no-await-in-loop -- pages are fetched one by one on purpose
      const data = await callApi('admin.listAttendance', { ...filters, page, page_size: EXPORT_PAGE_SIZE });
      total = data.total;
      rows.push(...data.rows);
      page += 1;
    } while (rows.length < total);
    downloadCsv(`attendance-records-${todayInManila()}.csv`, [
      ['Date', 'Class', 'Room', 'Student number', 'Student name', 'Scanned at', 'Status', 'Device status', 'Source', 'Sync', 'Corrected by', 'Corrected at', 'Reason'],
      ...rows.map((r) => [
        r.session_date, r.class_label, r.room_code, r.student_number, r.student_name, r.scanned_at, r.status, r.device_status,
        r.source, r.sync_mode === 'offline' ? 'synced later' : r.sync_mode, r.override_by_name || r.override_by, r.override_at, r.override_reason,
      ]),
    ]);
    note.textContent = `Exported ${rows.length} record${rows.length === 1 ? '' : 's'}.`;
  } catch (error) {
    note.textContent = `Export failed after ${rows.length} records: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

// ---------- Reports ----------

function mountReports(panel, options) {
  panel.innerHTML = `
    <form class="card card-body mb-3" id="reportFilter" novalidate>
      <div class="row g-2 align-items-end">
        <div class="col-6 col-md-4 col-xl-2">
          <label class="form-label small mb-1" for="f_group_by">Group by</label>
          <select class="form-select form-select-sm" id="f_group_by" name="group_by">
            <option value="class">Class</option><option value="section">Section</option><option value="student">Student</option>
          </select>
          <div class="invalid-feedback" data-error-for="group_by"></div>
        </div>
        ${dateHtml('from', 'From')}
        ${dateHtml('to', 'To')}
        ${selectHtml('class_id', 'Class', [], 'All classes')}
        ${selectHtml('section_id', 'Section', [], 'All sections')}
      </div>
      <div class="d-flex flex-wrap gap-2 mt-3">
        <button type="submit" class="btn btn-primary btn-sm"><i class="bi bi-bar-chart me-1" aria-hidden="true"></i>Show report</button>
        <span class="flex-grow-1"></span>
        <button type="button" class="btn btn-outline-secondary btn-sm" id="exportReport" disabled><i class="bi bi-download me-1" aria-hidden="true"></i>Export CSV</button>
      </div>
    </form>
    <div id="reportBody" aria-live="polite"></div>`;

  const form = panel.querySelector('#reportFilter');
  const body = panel.querySelector('#reportBody');
  const exportButton = panel.querySelector('#exportReport');
  let report = null;
  let request = 0;
  fillOptions(form, options);

  const load = async () => {
    const requestId = ++request;
    exportButton.disabled = true;
    showFieldErrors(form, {});
    body.innerHTML = `<div class="card">${loadingRows()}</div>`;
    try {
      const data = await callApi('admin.getAttendanceReport', Object.fromEntries(new FormData(form)));
      if (requestId !== request) return;
      report = data;
      body.innerHTML = reportHtml(data);
      exportButton.disabled = !data.groups.length;
    } catch (error) {
      if (requestId !== request) return;
      showFieldErrors(form, error.fields ?? {});
      body.innerHTML = `<div class="card">${errorStateHtml(error.message)}</div>`;
      body.querySelector('[data-action="retry"]').addEventListener('click', load);
    }
  };

  form.addEventListener('submit', (event) => { event.preventDefault(); load(); });
  exportButton.addEventListener('click', () => {
    const range = [report.range.from, report.range.to].filter(Boolean).join('_to_') || 'all';
    downloadCsv(`attendance-report-${report.group_by}-${range}.csv`, [
      [GROUP_LABEL[report.group_by], 'Sessions held', report.group_by === 'student' ? 'Classes' : 'Enrolled', 'Present', 'Late', 'Absent', 'Not yet', 'Rate'],
      ...report.groups.map((g) => [g.label, g.sessions_held, g.enrolled, g.present, g.late, g.absent, g.not_scanned, formatRate(g.rate)]),
      ['Total', '', '', report.totals.present, report.totals.late, report.totals.absent, report.totals.not_scanned, formatRate(report.totals.rate)],
    ]);
  });

  load();
  return { reload: load };
}

function reportHtml(data) {
  const queued = data.devices.filter((d) => d.queue_count > 0);
  const notice = data.pending_offline_scans > 0
    ? `<div class="alert alert-warning small" role="status"><i class="bi bi-cloud-arrow-up me-1" aria-hidden="true"></i>
        ${data.pending_offline_scans} scan(s) are still waiting on devices and are not in these numbers yet: ${queued.map((d) => `${escapeHtml(d.device_name)} (${escapeHtml(d.room_code || d.device_id)}) ${d.queue_count}`).join(', ')}.</div>`
    : '';
  if (!data.groups.length) {
    return `${notice}<div class="card">${stateHtml({ icon: 'bar-chart', title: 'Nothing to report', message: 'No classes match these filters.' })}</div>`;
  }
  const t = data.totals;
  return `
    ${notice}
    <div class="card">
      <div class="table-responsive">
        <table class="table table-hover align-middle mb-0">
          <thead><tr>
            <th>${GROUP_LABEL[data.group_by]}</th><th class="num">Sessions held</th><th class="num">${data.group_by === 'student' ? 'Classes' : 'Enrolled'}</th>
            <th class="num">Present</th><th class="num">Late</th><th class="num">Absent</th><th class="num">Not yet</th><th class="num">Rate</th>
          </tr></thead>
          <tbody>
            ${data.groups.map((g) => `
              <tr>
                <td class="cell-main">${escapeHtml(g.label)}</td>
                <td class="num">${escapeHtml(g.sessions_held)}</td><td class="num">${escapeHtml(g.enrolled)}</td>
                <td class="num">${escapeHtml(g.present)}</td><td class="num">${escapeHtml(g.late)}</td><td class="num">${escapeHtml(g.absent)}</td>
                <td class="num">${escapeHtml(g.not_scanned)}</td><td class="num fw-semibold">${escapeHtml(formatRate(g.rate))}</td>
              </tr>`).join('')}
          </tbody>
          <tfoot><tr class="fw-semibold">
            <td>Total</td><td></td><td></td>
            <td class="num">${escapeHtml(t.present)}</td><td class="num">${escapeHtml(t.late)}</td><td class="num">${escapeHtml(t.absent)}</td>
            <td class="num">${escapeHtml(t.not_scanned)}</td><td class="num">${escapeHtml(formatRate(t.rate))}</td>
          </tr></tfoot>
        </table>
      </div>
      <div class="px-3 py-2 border-top small text-secondary">${data.groups.length} ${GROUP_LABEL[data.group_by].toLowerCase()}${data.groups.length === 1 ? '' : 's'} · generated ${escapeHtml(formatDateTime(data.generated_at))}</div>
    </div>`;
}
