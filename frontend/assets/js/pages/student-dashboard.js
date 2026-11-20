import { callApi } from '../api.js';
import { requireRole, appUrl } from '../auth.js';
import {
  renderShell, escapeHtml, formatClockTime, formatTimestamp, stateHtml, errorStateHtml,
} from '../ui.js';
import {
  statCard, formatRate, rateMeterHtml, rateTone, attendanceBadge, formatDateShort, scheduleHtml, loadingCardsHtml,
} from '../components/attendance-ui.js';

const session = requireRole('student');
if (session) start();

function start() {
  const content = renderShell({ role: 'student', active: 'dashboard', title: 'My Attendance', session });
  content.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">Hi, ${escapeHtml(session.display_name.split(' ')[0])}!</h2>
        <p class="page-subtitle" id="profileLine">Loading…</p>
      </div>
      <a class="btn btn-light border" href="${appUrl('student/history.html')}"><i class="bi bi-clock-history me-1" aria-hidden="true"></i>Full history</a>
    </div>
    <div id="overviewBody">${loadingCardsHtml()}</div>`;

  const body = document.getElementById('overviewBody');
  const load = async () => {
    try {
      const data = await callApi('student.getOverview');
      const { profile } = data;
      document.getElementById('profileLine').textContent = `${profile.student_number} · ${profile.section_label}${data.term_name ? ` · ${data.term_name}` : ''}`;
      body.innerHTML = overviewHtml(data);
    } catch (error) {
      body.innerHTML = `<div class="card">${errorStateHtml(error.message)}</div>`;
      body.querySelector('[data-action="retry"]').addEventListener('click', load);
    }
  };
  load();
}

function overviewHtml(data) {
  const { totals } = data;
  return `
    <div class="row g-3 mb-3">
      ${statCard({ icon: 'graph-up', label: 'Overall attendance', value: formatRate(totals.rate), hint: `${totals.total} class session${totals.total === 1 ? '' : 's'} so far` })}
      ${statCard({ icon: 'check-circle', label: 'Present', value: totals.present, hint: 'Tapped in', gold: true })}
      ${statCard({ icon: 'clock', label: 'Late', value: totals.late, hint: 'Set by your instructor (a tap is always present)' })}
      ${statCard({ icon: 'x-circle', label: 'Absent', value: totals.absent, hint: 'No tap, or marked absent', gold: true })}
    </div>
    ${totals.rate !== null && totals.rate < 0.8 ? `
      <div class="alert alert-warning d-flex gap-2 align-items-start" role="status">
        <i class="bi bi-exclamation-triangle mt-1" aria-hidden="true"></i>
        <div>Your overall attendance is below 80%. Please talk to your instructors if you have concerns about your records.</div>
      </div>` : ''}
    <div class="row g-3">
      <div class="col-xl-8">${subjectsHtml(data.subjects)}</div>
      <div class="col-xl-4 d-flex flex-column gap-3">
        ${todayHtml(data)}
        ${recentHtml(data.recent)}
      </div>
    </div>`;
}

function subjectsHtml(subjects) {
  const body = subjects.length
    ? subjects.map((row) => `
      <div class="subject-item">
        <div class="d-flex justify-content-between align-items-start gap-2 flex-wrap">
          <div class="min-w-0">
            <div class="class-card-code">${escapeHtml(row.subject_code)} · ${escapeHtml(row.section_label)}</div>
            <div class="cell-main">${escapeHtml(row.subject_title)}</div>
            <div class="cell-sub"><i class="bi bi-person-video3 me-1" aria-hidden="true"></i>${escapeHtml(row.instructor_name)}</div>
          </div>
          <div class="text-end">
            <div class="subject-rate text-${rateTone(row.rate)}-emphasis">${formatRate(row.rate)}</div>
            <div class="small text-secondary">${row.total} session${row.total === 1 ? '' : 's'}</div>
          </div>
        </div>
        ${rateMeterHtml(row.rate, `${row.subject_title} attendance`)}
        <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mt-2">
          <div class="session-counts mt-0">
            <span><strong>${row.present}</strong> present</span><span><strong>${row.late}</strong> late</span><span><strong>${row.absent}</strong> absent</span>
          </div>
          <a class="small text-decoration-none" href="${appUrl('student/history.html')}?class=${encodeURIComponent(row.class_id)}">View history <i class="bi bi-arrow-right" aria-hidden="true"></i></a>
        </div>
        <div class="schedule-list small mt-2">${scheduleHtml(row.schedules)}</div>
      </div>`).join('')
    : stateHtml({ icon: 'journal-x', title: 'Not enrolled in any class', message: 'Your classes appear here once the administrator enrolls you.' });
  return `
    <div class="card h-100">
      <div class="card-header border-bottom">
        <h3 class="card-title-sm">Attendance per subject</h3>
        <span class="small text-secondary">${subjects.length} subject${subjects.length === 1 ? '' : 's'}</span>
      </div>
      ${body}
    </div>`;
}

function todayHtml(data) {
  const body = data.today.length
    ? data.today.map((slot) => `
      <div class="attention-item">
        <span class="attention-icon info" aria-hidden="true"><i class="bi bi-clock"></i></span>
        <div class="min-w-0">
          <div class="cell-main">${escapeHtml(slot.class_label)}</div>
          <div class="cell-sub">${formatClockTime(slot.start_time)}–${formatClockTime(slot.end_time)} · ${escapeHtml(slot.room_code)}</div>
        </div>
      </div>`).join('')
    : stateHtml({ icon: 'cup-hot', title: 'No classes today' });
  return `
    <div class="card">
      <div class="card-header border-bottom">
        <h3 class="card-title-sm">Today's classes</h3>
        <span class="small text-secondary">${escapeHtml(formatDateShort(data.today_date))}</span>
      </div>
      ${body}
      <div class="card-body border-top small text-secondary py-2"><i class="bi bi-credit-card-2-front me-1" aria-hidden="true"></i>Tap your RFID card on the reader when you enter the room.</div>
    </div>`;
}

function recentHtml(recent) {
  const body = recent.length
    ? `<ul class="list-group list-group-flush small">${recent.map((row) => `
        <li class="list-group-item d-flex justify-content-between align-items-center gap-2">
          <div class="min-w-0">
            <div class="fw-semibold text-truncate">${escapeHtml(row.class_label)}</div>
            <div class="text-secondary">${escapeHtml(formatDateShort(row.session_date))}${row.scanned_at ? ` · ${escapeHtml(formatTimestamp(row.scanned_at))}` : ''}</div>
          </div>
          ${attendanceBadge(row.status)}
        </li>`).join('')}</ul>`
    : stateHtml({ icon: 'calendar', title: 'No records yet' });
  return `
    <div class="card flex-grow-1">
      <div class="card-header border-bottom">
        <h3 class="card-title-sm">Recent records</h3>
        <a class="small text-decoration-none" href="${appUrl('student/history.html')}">See all</a>
      </div>
      ${body}
    </div>`;
}
