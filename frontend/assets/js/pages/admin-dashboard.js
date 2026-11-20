import { callApi } from '../api.js';
import { requireRole } from '../auth.js';
import {
  renderShell, escapeHtml, todayInManila, formatDateLong, formatClockTime,
  formatTimestamp, formatRelative, stateHtml, errorStateHtml,
} from '../ui.js';
import { badge, statCard, countsBarHtml, phaseBadge } from '../components/attendance-ui.js';

const SCAN_RESULT = {
  ACCEPTED: { label: 'Accepted', tone: 'success' },
  DUPLICATE: { label: 'Duplicate', tone: 'secondary' },
  UNREGISTERED: { label: 'Unregistered', tone: 'danger' },
  NOT_ENROLLED: { label: 'Not enrolled', tone: 'warning' },
  NO_ACTIVE_SESSION: { label: 'No class', tone: 'warning' },
  SESSION_CANCELLED: { label: 'Class cancelled', tone: 'secondary' },
  INVALID_TIME: { label: 'Invalid time', tone: 'danger' },
};

const session = requireRole('admin');
if (session) start();

function start() {
  const content = renderShell({ role: 'admin', active: 'dashboard', title: 'Dashboard', session });
  const today = todayInManila();

  content.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">Attendance overview</h2>
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
    body.innerHTML = loadingHtml();
    try {
      const data = await callApi('admin.getDashboard', { date });
      if (requestId !== requestCounter) return;
      body.innerHTML = dashboardHtml(data);
    } catch (error) {
      if (requestId !== requestCounter) return;
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

  load();
}

function loadingHtml() {
  const block = (height) => `<div class="skeleton" style="height:${height}px"></div>`;
  return `
    <div class="row g-3 mb-3" aria-busy="true" aria-label="Loading dashboard">
      ${[1, 2, 3, 4].map(() => `<div class="col-6 col-xl-3">${block(96)}</div>`).join('')}
    </div>
    <div class="row g-3">
      <div class="col-xl-8">${block(320)}</div>
      <div class="col-xl-4">${block(320)}</div>
    </div>`;
}

function dashboardHtml(data) {
  return `
    ${statsHtml(data)}
    ${alertsHtml(data.alerts)}
    <div class="row g-3 mb-3">
      <div class="col-xl-8">${sessionsHtml(data)}</div>
      <div class="col-xl-4">${devicesHtml(data.devices)}</div>
    </div>
    ${scansHtml(data.recent_scans)}`;
}

function statsHtml({ stats }) {
  const rate = stats.attendance_rate === null ? '—' : `${Math.round(stats.attendance_rate * 100)}%`;
  return `
    <div class="row g-3 mb-3">
      ${statCard({ icon: 'person-check', label: 'Students present', value: stats.students_present, hint: `of ${stats.active_students} active students` })}
      ${statCard({ icon: 'graph-up', label: 'Attendance rate', value: rate, hint: stats.attendance_rate === null ? 'No sessions with scans yet' : 'Present + late of enrolled, sessions with scans', gold: true })}
      ${statCard({ icon: 'calendar3', label: 'Class sessions', value: stats.sessions_on_date, hint: `${stats.active_classes} active classes · ${stats.active_instructors} instructors` })}
      ${statCard({ icon: 'router', label: 'Devices online', value: `${stats.devices_online}/${stats.devices_total}`, hint: 'Based on last check-in', gold: true })}
    </div>`;
}

function alertsHtml(alerts) {
  if (!alerts.length) return '';
  const detailsHtml = (details = []) => (details.length
    ? `<div class="cell-sub mt-1">${details.map((item) => `${escapeHtml(item.label)} · ${item.since ? `last seen ${escapeHtml(formatRelative(item.since))}` : 'never connected'}`).join('<br>')}</div>`
    : '');
  return `
    <div class="card mb-3">
      <div class="card-header border-bottom">
        <h3 class="card-title-sm">Needs attention</h3>
        <span class="badge rounded-pill text-bg-light border">${alerts.length}</span>
      </div>
      ${alerts.map((alert) => `
        <div class="attention-item" role="${alert.level === 'danger' ? 'alert' : 'status'}">
          <span class="attention-icon ${alert.level}" aria-hidden="true"><i class="bi bi-${alert.icon}"></i></span>
          <div class="min-w-0">${escapeHtml(alert.message)}${detailsHtml(alert.details)}</div>
        </div>`).join('')}
    </div>`;
}

function sessionsHtml(data) {
  let body;
  if (!data.in_term) {
    body = stateHtml({ icon: 'calendar-x', title: 'Outside the active term', message: data.term_name ? `${data.term_name} does not include this date.` : 'No active term is set.' });
  } else if (!data.sessions.length) {
    body = stateHtml({ icon: 'calendar', title: 'No classes scheduled', message: 'There are no class schedules on this day.' });
  } else {
    body = `
      <div class="table-responsive d-none d-md-block">
        <table class="table table-hover align-middle">
          <thead>
            <tr><th>Time</th><th>Class</th><th>Room</th><th>Status</th><th class="num">Present</th><th class="num">Late</th><th class="num">Absent</th><th class="num">Not yet</th></tr>
          </thead>
          <tbody>${data.sessions.map(sessionRowHtml).join('')}</tbody>
        </table>
      </div>
      <div class="d-md-none">${data.sessions.map(sessionItemHtml).join('')}</div>`;
  }
  return `
    <div class="card h-100">
      <div class="card-header border-bottom">
        <h3 class="card-title-sm">Class sessions</h3>
        <span class="small text-secondary">${data.sessions.length} on this day</span>
      </div>
      ${body}
    </div>`;
}

function sessionItemHtml(row) {
  const counts = row.present === null
    ? `<div class="session-counts"><span>${row.enrolled} enrolled</span></div>`
    : `<div class="session-counts">
        <span><strong>${row.present}</strong> present</span><span><strong>${row.late}</strong> late</span><span><strong>${row.absent}</strong> absent</span><span><strong>${row.not_scanned}</strong> not yet</span>
      </div>`;
  return `
    <div class="session-item">
      <div class="d-flex justify-content-between align-items-start gap-2">
        <div class="min-w-0">
          <div class="cell-main">${escapeHtml(row.class_label)}${row.source === 'manual' ? ' <span class="badge text-bg-light border ms-1">Manual</span>' : ''}</div>
          <div class="cell-sub">${escapeHtml(formatClockTime(row.start_time))}–${escapeHtml(formatClockTime(row.end_time))} · ${escapeHtml(row.room_code)} · ${escapeHtml(row.instructor_name)}</div>
        </div>
        ${phaseBadge(row)}
      </div>
      ${counts}
      ${countsBarHtml(row)}
    </div>`;
}

function sessionRowHtml(row) {
  const counted = row.present !== null;
  const bar = countsBarHtml(row);
  const cell = (value) => (counted ? value : '<span class="text-secondary">—</span>');
  return `
    <tr>
      <td class="text-nowrap"><div class="cell-main">${escapeHtml(formatClockTime(row.start_time))}</div><div class="cell-sub">to ${escapeHtml(formatClockTime(row.end_time))}</div></td>
      <td>
        <div class="cell-main">${escapeHtml(row.class_label)}${row.source === 'manual' ? ' <span class="badge text-bg-light border ms-1">Manual</span>' : ''}</div>
        <div class="cell-sub">${escapeHtml(row.subject_title)} · ${escapeHtml(row.instructor_name)} · ${row.enrolled} enrolled</div>
        ${bar}
      </td>
      <td class="text-nowrap">${escapeHtml(row.room_code)}</td>
      <td>${phaseBadge(row)}</td>
      <td class="num">${cell(row.present)}</td>
      <td class="num">${cell(row.late)}</td>
      <td class="num">${cell(row.absent)}</td>
      <td class="num">${cell(row.not_scanned)}</td>
    </tr>`;
}

function devicesHtml(devices) {
  const items = devices.length
    ? devices.map((device) => `
      <div class="device-item">
        <div class="d-flex justify-content-between align-items-start gap-2">
          <div class="min-w-0">
            <div class="cell-main">${escapeHtml(device.device_name)}</div>
            <div class="cell-sub">${escapeHtml(device.room_code)} · ${escapeHtml(device.device_id)}</div>
          </div>
          <span class="small text-nowrap"><span class="status-dot ${device.online ? 'online' : 'offline'}" aria-hidden="true"></span>${device.online ? 'Online' : 'Offline'}</span>
        </div>
        <div class="d-flex flex-wrap gap-2 mt-2 small">
          <span class="badge rounded-pill ${device.low_battery ? 'text-bg-danger' : 'text-bg-light border'}">
            <i class="bi bi-battery${device.low_battery ? '-half' : '-full'} me-1" aria-hidden="true"></i>${device.battery_voltage === null ? 'No reading' : `${device.battery_voltage.toFixed(2)} V`}${device.low_battery ? ' · Low' : ''}
          </span>
          ${device.queue_count > 0 ? `<span class="badge rounded-pill text-bg-warning"><i class="bi bi-cloud-arrow-up me-1" aria-hidden="true"></i>${device.queue_count} queued</span>` : ''}
          <span class="text-secondary">${device.last_seen_at ? `Last seen ${escapeHtml(formatRelative(device.last_seen_at))}` : 'Never connected'}</span>
        </div>
      </div>`).join('')
    : stateHtml({ icon: 'router', title: 'No devices registered' });
  return `
    <div class="card h-100">
      <div class="card-header border-bottom">
        <h3 class="card-title-sm">Devices</h3>
        <span class="small text-secondary">Current status</span>
      </div>
      ${items}
    </div>`;
}

function scansHtml(scans) {
  const body = scans.length
    ? `
      <div class="table-responsive">
        <table class="table align-middle">
          <thead><tr><th>Time</th><th>Student / card</th><th class="d-none d-sm-table-cell">Room</th><th>Result</th><th class="d-none d-sm-table-cell">Sync</th></tr></thead>
          <tbody>
            ${scans.map((scan) => `
              <tr>
                <td class="text-nowrap">${escapeHtml(formatTimestamp(scan.scanned_at))}</td>
                <td>${scan.student_name
                  ? `<div class="cell-main">${escapeHtml(scan.student_name)}</div>`
                  : '<div class="cell-main text-danger">Unknown card</div>'}
                  <div class="cell-sub font-monospace">${escapeHtml(scan.rfid_uid)}</div></td>
                <td class="d-none d-sm-table-cell">${escapeHtml(scan.room_code)}</td>
                <td>${badge(SCAN_RESULT[scan.result] ?? { label: scan.result, tone: 'secondary' })}</td>
                <td class="d-none d-sm-table-cell">${scan.sync_mode === 'offline'
                  ? '<span class="small"><i class="bi bi-cloud-arrow-up me-1" aria-hidden="true"></i>Offline sync</span>'
                  : '<span class="small text-secondary">Live</span>'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`
    : stateHtml({ icon: 'broadcast', title: 'No scans on this day', message: 'Scans from all devices will appear here.' });
  return `
    <div class="card">
      <div class="card-header border-bottom">
        <h3 class="card-title-sm">Recent scans</h3>
        <span class="small text-secondary">Latest 10 for this day</span>
      </div>
      ${body}
    </div>`;
}
