// Side panel for instructors:
//  - openClassRoster(): everyone enrolled in a class (subject + section)
//  - openStudentHistory(): one student's attendance in that class
// Used by the instructor Dashboard, Attendance and Class Reports pages.
import { callApi } from '../api.js';
import { escapeHtml, formatClockTime, formatTimestamp, errorStateHtml, stateHtml } from '../ui.js';
import { appUrl } from '../auth.js';
import {
  attendanceBadge, formatDateShort, formatRate, rateMeterHtml, rateTone, scheduleHtml,
} from '../components/attendance-ui.js';

let panel = null;
let currentKey = '';

function ensurePanel() {
  if (panel) return panel;
  const element = document.createElement('div');
  element.className = 'offcanvas offcanvas-end';
  element.tabIndex = -1;
  element.id = 'studentHistory';
  element.style.setProperty('--bs-offcanvas-width', '460px');
  element.setAttribute('aria-labelledby', 'studentHistoryTitle');
  element.innerHTML = `
    <div class="offcanvas-header border-bottom">
      <h2 class="offcanvas-title fs-5" id="studentHistoryTitle">Attendance history</h2>
      <button type="button" class="btn-close" data-bs-dismiss="offcanvas" aria-label="Close"></button>
    </div>
    <div class="offcanvas-body" id="studentHistoryBody"></div>`;
  document.body.append(element);
  panel = { element, offcanvas: new window.bootstrap.Offcanvas(element), body: element.querySelector('#studentHistoryBody') };
  element.addEventListener('hidden.bs.offcanvas', () => { currentKey = ''; });
  element.addEventListener('click', (event) => {
    const student = event.target.closest('[data-roster-student]');
    if (student) openStudentHistory(student.dataset.classId, student.dataset.rosterStudent, { back: true });
    const back = event.target.closest('[data-roster-back]');
    if (back) openClassRoster(back.dataset.rosterBack);
  });
  return panel;
}

export async function openClassRoster(classId) {
  const { offcanvas, body, element } = ensurePanel();
  const key = `roster:${classId}`;
  currentKey = key;
  element.querySelector('.offcanvas-title').textContent = 'Class roster';
  body.innerHTML = '<div class="skeleton mb-3" style="height:110px"></div><div class="skeleton" style="height:300px"></div>';
  offcanvas.show();
  try {
    const data = await callApi('instructor.getClassRoster', { class_id: classId });
    if (currentKey !== key) return;
    body.innerHTML = rosterHtml(data);
  } catch (error) {
    if (currentKey !== key) return;
    body.innerHTML = errorStateHtml(error.message);
    body.querySelector('[data-action="retry"]').addEventListener('click', () => openClassRoster(classId));
  }
}

function rosterHtml({ class: klass, students }) {
  const list = students.length
    ? `<div class="list-group list-group-flush">${students.map((s) => `
        <button type="button" class="list-group-item list-group-item-action px-0 d-flex justify-content-between align-items-center gap-2" data-roster-student="${escapeHtml(s.student_id)}" data-class-id="${escapeHtml(klass.class_id)}">
          <div class="min-w-0">
            <div class="fw-semibold">${escapeHtml(`${s.last_name}, ${s.first_name}`)}</div>
            <div class="small text-secondary">${escapeHtml(s.student_number)}${s.other_section ? ` · <span class="badge text-bg-light border">${escapeHtml(s.section_label)}</span>` : ''}${s.has_card ? '' : ' · <span class="text-danger">no RFID card</span>'}</div>
          </div>
          <div class="text-end small text-nowrap">
            ${s.total ? `<div class="fw-semibold text-${rateTone(s.rate)}-emphasis">${formatRate(s.rate)}</div><div class="text-secondary">${s.absent} absent · ${s.late} late</div>` : '<span class="text-secondary">No sessions yet</span>'}
          </div>
        </button>`).join('')}</div>`
    : stateHtml({ icon: 'people', title: 'No students enrolled', message: 'Ask the administrator to enroll the section in this class.' });
  return `
    <div class="class-card-code">${escapeHtml(klass.subject_code)} · ${escapeHtml(klass.section_label)}</div>
    <div class="fs-5 fw-semibold">${escapeHtml(klass.subject_title)}</div>
    <div class="schedule-list small">${scheduleHtml(klass.schedules)}</div>
    <div class="d-flex flex-wrap gap-2 my-3">
      <span class="badge rounded-pill text-bg-light border"><i class="bi bi-people me-1" aria-hidden="true"></i>${klass.enrolled} students</span>
      <span class="badge rounded-pill text-bg-light border"><i class="bi bi-calendar-check me-1" aria-hidden="true"></i>${klass.sessions_held} session${klass.sessions_held === 1 ? '' : 's'} held</span>
    </div>
    <div class="d-flex gap-2 mb-3">
      <a class="btn btn-sm btn-outline-primary flex-fill" href="${appUrl('instructor/attendance.html')}?class=${encodeURIComponent(klass.class_id)}"><i class="bi bi-clipboard-check me-1" aria-hidden="true"></i>Attendance</a>
      <a class="btn btn-sm btn-light border flex-fill" href="${appUrl('instructor/reports.html')}?class=${encodeURIComponent(klass.class_id)}"><i class="bi bi-file-earmark-bar-graph me-1" aria-hidden="true"></i>Report</a>
    </div>
    <h3 class="h6 text-uppercase text-secondary small fw-semibold">Students <span class="fw-normal text-lowercase">· tap a name for their history</span></h3>
    ${list}`;
}

export async function openStudentHistory(classId, studentId, { back = false } = {}) {
  const { offcanvas, body, element } = ensurePanel();
  element.querySelector('.offcanvas-title').textContent = 'Attendance history';
  const key = `${classId}:${studentId}`;
  currentKey = key;
  body.innerHTML = '<div class="skeleton mb-3" style="height:110px"></div><div class="skeleton" style="height:260px"></div>';
  offcanvas.show();
  try {
    const data = await callApi('instructor.getStudentHistory', { class_id: classId, student_id: studentId });
    if (currentKey !== key) return;
    body.innerHTML = (back ? `<button type="button" class="btn btn-sm btn-link px-0 mb-2 text-decoration-none" data-roster-back="${escapeHtml(classId)}"><i class="bi bi-arrow-left me-1" aria-hidden="true"></i>Back to class</button>` : '') + historyHtml(data);
  } catch (error) {
    if (currentKey !== key) return;
    body.innerHTML = errorStateHtml(error.message);
    body.querySelector('[data-action="retry"]').addEventListener('click', () => openStudentHistory(classId, studentId, { back }));
  }
}

function historyHtml({ student, class: klass, records, totals }) {
  const list = records.length
    ? `<ul class="list-group list-group-flush small">${records.map((row) => `
        <li class="list-group-item px-0 d-flex justify-content-between align-items-center gap-2">
          <div class="min-w-0">
            <div class="fw-semibold">${escapeHtml(formatDateShort(row.session_date))}</div>
            <div class="text-secondary">${formatClockTime(row.start_time)}–${formatClockTime(row.end_time)} · ${escapeHtml(row.room_code)}${row.scanned_at ? ` · tapped ${escapeHtml(formatTimestamp(row.scanned_at))}` : ''}${row.corrected ? ' · corrected' : (row.manual ? ' · manual' : '')}</div>
          </div>
          ${attendanceBadge(row.status)}
        </li>`).join('')}</ul>`
    : stateHtml({ icon: 'calendar', title: 'No sessions yet' });
  return `
    <div class="fs-5 fw-semibold">${escapeHtml(student.name)}</div>
    <div class="text-secondary small mb-3">${escapeHtml(student.student_number)} · ${escapeHtml(student.section_label)} · ${escapeHtml(klass.class_label)}</div>
    <div class="row g-2 text-center summary-tiles mb-2">
      <div class="col-3"><div class="summary-tile"><div class="summary-num">${formatRate(totals.rate)}</div><div class="summary-label">Rate</div></div></div>
      <div class="col-3"><div class="summary-tile tone-success"><div class="summary-num">${totals.present}</div><div class="summary-label">Present</div></div></div>
      <div class="col-3"><div class="summary-tile tone-warning"><div class="summary-num">${totals.late}</div><div class="summary-label">Late</div></div></div>
      <div class="col-3"><div class="summary-tile tone-danger"><div class="summary-num">${totals.absent}</div><div class="summary-label">Absent</div></div></div>
    </div>
    ${rateMeterHtml(totals.rate)}
    <h3 class="h6 text-uppercase text-secondary small fw-semibold mt-4">Sessions</h3>
    ${list}`;
}
