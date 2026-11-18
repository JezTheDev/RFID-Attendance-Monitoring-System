import { callApi } from '../api.js';
import { requireRole, appUrl } from '../auth.js';
import {
  renderShell, escapeHtml, todayInManila, formatDateLong, formatClockTime, stateHtml, errorStateHtml,
} from '../ui.js';
import {
  sessionBadge, statCard, formatRate, rateMeterHtml, rateTone, countsBarHtml, scheduleHtml, loadingCardsHtml,
} from '../components/attendance-ui.js';
import { openClassRoster } from './instructor-history.js';

const session = requireRole('instructor');
if (session) start();

function start() {
  const content = renderShell({ role: 'instructor', active: 'dashboard', title: 'Dashboard', session });
  const today = todayInManila();

  content.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">${escapeHtml(greeting())}, ${escapeHtml(session.display_name.split(' ')[0])}</h2>
        <p class="page-subtitle" id="dateLabel"></p>
      </div>
      <form class="d-flex flex-wrap align-items-center gap-2" id="dateForm" aria-label="Choose date">
        <div class="input-group" style="width:auto">
          <button class="btn btn-outline-secondary" type="button" data-shift="-1" aria-label="Previous day"><i class="bi bi-chevron-left" aria-hidden="true"></i></button>
          <input type="date" class="form-control" id="dateInput" value="${today}" required aria-label="Date">
          <button class="btn btn-outline-secondary" type="button" data-shift="1" aria-label="Next day"><i class="bi bi-chevron-right" aria-hidden="true"></i></button>
        </div>
        <button class="btn btn-outline-primary" type="button" id="todayButton">Today</button>
      </form>
    </div>
    <div id="dashboardBody"></div>`;

  const input = document.getElementById('dateInput');
  let requestCounter = 0;

  const load = async () => {
    const date = input.value;
    if (!date) return;
    document.getElementById('dateLabel').textContent = formatDateLong(date) + (date === today ? ' · Today' : '');
    const body = document.getElementById('dashboardBody');
    const requestId = ++requestCounter;
    if (!body.children.length) body.innerHTML = loadingCardsHtml();
    try {
      const data = await callApi('instructor.getDashboard', { date });
      if (requestId !== requestCounter) return;
      body.innerHTML = dashboardHtml(data);
    } catch (error) {
      if (requestId !== requestCounter) return;
      if (error.code === 'NOT_SIGNED_IN') {
        requireRole('instructor');
        return;
      }
      body.innerHTML = `<div class="card">${errorStateHtml(error.message)}</div>`;
      body.querySelector('[data-action="retry"]').addEventListener('click', load);
    }
  };

  input.addEventListener('change', load);
  document.querySelectorAll('[data-shift]').forEach((button) => button.addEventListener('click', () => {
    if (!input.value) input.value = today;
    const [y, m, d] = input.value.split('-').map(Number);
    input.value = new Date(Date.UTC(y, m - 1, d + Number(button.dataset.shift))).toISOString().slice(0, 10);
    load();
  }));
  document.getElementById('todayButton').addEventListener('click', () => {
    input.value = today;
    load();
  });
  document.getElementById('dateForm').addEventListener('submit', (event) => event.preventDefault());
  document.getElementById('dashboardBody').addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-roster]');
    if (trigger) openClassRoster(trigger.dataset.roster);
  });
  document.getElementById('dashboardBody').addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.class-card-open')) {
      event.preventDefault();
      openClassRoster(event.target.dataset.roster);
    }
  });

  load();
}

function greeting() {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function attendanceLink(classId, sessionId) {
  const params = new URLSearchParams({ class: classId });
  if (sessionId) params.set('session', sessionId);
  return `${appUrl('instructor/attendance.html')}?${params}`;
}

function reportLink(classId) {
  return `${appUrl('instructor/reports.html')}?class=${encodeURIComponent(classId)}`;
}

function dashboardHtml(data) {
  const { stats } = data;
  return `
    <div class="row g-3 mb-3">
      ${statCard({ icon: 'journal-bookmark', label: 'My classes', value: stats.classes, hint: data.term_name ?? 'No active term' })}
      ${statCard({ icon: 'people', label: 'Students', value: stats.students, hint: 'Enrolled across your classes', gold: true })}
      ${statCard({ icon: 'calendar3', label: 'Sessions on this day', value: stats.sessions_on_date, hint: data.in_term ? 'From your class schedules' : 'Outside the active term' })}
      ${statCard({ icon: 'graph-up', label: 'Term attendance', value: formatRate(stats.attendance_rate), hint: 'Present + late, completed sessions', gold: true })}
    </div>
    <div class="row g-3 mb-3">
      <div class="col-xl-8">${sessionsHtml(data)}</div>
      <div class="col-xl-4">${watchlistHtml(data.watchlist)}</div>
    </div>
    ${classesHtml(data.classes)}`;
}

function sessionsHtml(data) {
  let body;
  if (!data.in_term) {
    body = stateHtml({ icon: 'calendar-x', title: 'Outside the active term', message: data.term_name ? `${data.term_name} does not include this date.` : 'No active term is set.' });
  } else if (!data.sessions.length) {
    body = stateHtml({ icon: 'cup-hot', title: 'No classes on this day', message: 'You have no scheduled class sessions on this date.' });
  } else {
    body = data.sessions.map((row) => {
      const counted = row.present !== null;
      const counts = counted
        ? `<div class="session-counts">
            <span><strong>${row.present}</strong> present</span><span><strong>${row.late}</strong> late</span><span><strong>${row.absent}</strong> absent</span><span class="text-secondary">of ${row.enrolled}</span>
          </div>${countsBarHtml(row)}`
        : `<div class="session-counts"><span>${row.enrolled} enrolled</span></div>`;
      const action = row.session_id
        ? `<a class="btn btn-sm btn-outline-primary" href="${attendanceLink(row.class_id, row.session_id)}"><i class="bi bi-clipboard-check me-1" aria-hidden="true"></i>View attendance</a>`
        : '';
      return `
        <div class="session-item">
          <div class="d-flex justify-content-between align-items-start gap-2 flex-wrap">
            <div class="min-w-0">
              <button type="button" class="btn btn-link p-0 text-start text-decoration-none cell-main" data-roster="${escapeHtml(row.class_id)}">${escapeHtml(row.class_label)}</button>${row.source === 'manual' ? ' <span class="badge text-bg-light border ms-1">Manual</span>' : ''}
              <div class="cell-sub">${formatClockTime(row.start_time)}–${formatClockTime(row.end_time)} · ${escapeHtml(row.room_code)}</div>
            </div>
            <div class="d-flex align-items-center gap-2">${sessionBadge(row.status)}${action}</div>
          </div>
          ${counts}
        </div>`;
    }).join('');
  }
  return `
    <div class="card h-100">
      <div class="card-header border-bottom">
        <h3 class="card-title-sm">My sessions</h3>
        <span class="small text-secondary">${data.sessions.length} on this day</span>
      </div>
      ${body}
    </div>`;
}

function watchlistHtml(rows) {
  const body = rows.length
    ? rows.map((row) => `
      <div class="attention-item">
        <span class="attention-icon ${row.rate < 0.7 ? 'danger' : 'warning'}" aria-hidden="true"><i class="bi bi-person-exclamation"></i></span>
        <div class="min-w-0 flex-grow-1">
          <div class="d-flex justify-content-between gap-2">
            <span class="cell-main text-truncate">${escapeHtml(row.student_name)}</span>
            <span class="fw-semibold text-${rateTone(row.rate)}-emphasis">${formatRate(row.rate)}</span>
          </div>
          <div class="cell-sub">${escapeHtml(row.class_label)} · ${row.absent} absent · ${row.late} late of ${row.total}</div>
        </div>
      </div>`).join('')
    : stateHtml({ icon: 'emoji-smile', title: 'Everyone is on track', message: 'No student is below 80% attendance.' });
  return `
    <div class="card h-100">
      <div class="card-header border-bottom">
        <h3 class="card-title-sm">Needs follow-up</h3>
        <span class="small text-secondary">Below 80%</span>
      </div>
      ${body}
    </div>`;
}

function classesHtml(classes) {
  if (!classes.length) {
    return `<div class="card">${stateHtml({ icon: 'journal-x', title: 'No classes assigned', message: 'The administrator has not assigned any class to you yet.' })}</div>`;
  }
  return `
    <div class="d-flex align-items-center justify-content-between mb-2">
      <h3 class="h6 mb-0 fw-semibold">My classes &amp; schedules</h3>
      <span class="small text-secondary">${classes.length} assigned</span>
    </div>
    <div class="row g-3">
      ${classes.map((klass) => `
        <div class="col-md-6 col-xxl-4">
          <div class="card class-card h-100">
            <div class="card-body class-card-open" role="button" tabindex="0" data-roster="${escapeHtml(klass.class_id)}" aria-label="Show students of ${escapeHtml(klass.class_label)}">
              <div class="d-flex justify-content-between align-items-start gap-2">
                <div class="min-w-0">
                  <div class="class-card-code">${escapeHtml(klass.subject_code)} · ${escapeHtml(klass.section_label)}</div>
                  <div class="class-card-title">${escapeHtml(klass.subject_title)}</div>
                </div>
                <span class="badge rounded-pill text-bg-light border"><i class="bi bi-people me-1" aria-hidden="true"></i>${klass.enrolled} students</span>
              </div>
              <div class="schedule-list">${scheduleHtml(klass.schedules)}</div>
              <div class="d-flex justify-content-between align-items-end small mt-3">
                <span class="text-secondary">${klass.sessions_held} session${klass.sessions_held === 1 ? '' : 's'} held</span>
                <span class="fw-semibold">${formatRate(klass.attendance_rate)} attendance</span>
              </div>
              ${rateMeterHtml(klass.attendance_rate)}
            </div>
            <div class="card-footer bg-transparent d-flex gap-2">
              <button type="button" class="btn btn-sm btn-primary flex-fill" data-roster="${escapeHtml(klass.class_id)}"><i class="bi bi-people me-1" aria-hidden="true"></i>Students</button>
              <a class="btn btn-sm btn-outline-primary flex-fill" href="${attendanceLink(klass.class_id)}"><i class="bi bi-clipboard-check me-1" aria-hidden="true"></i>Attendance</a>
              <a class="btn btn-sm btn-light border flex-fill" href="${reportLink(klass.class_id)}"><i class="bi bi-file-earmark-bar-graph me-1" aria-hidden="true"></i>Report</a>
            </div>
          </div>
        </div>`).join('')}
    </div>`;
}
