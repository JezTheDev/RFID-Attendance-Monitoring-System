import { callApi } from '../api.js';
import { requireRole } from '../auth.js';
import {
  renderShell, escapeHtml, initials, formatDateTime, stateHtml, errorStateHtml,
} from '../ui.js';
import { scheduleHtml } from '../components/attendance-ui.js';

const session = requireRole('student');
if (session) start();

function start() {
  const content = renderShell({ role: 'student', active: 'profile', title: 'My Profile', session });
  content.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">My profile</h2>
        <p class="page-subtitle">Your details as registered by the administrator. This page is view only.</p>
      </div>
    </div>
    <div id="profileBody"><div class="row g-3"><div class="col-lg-5"><div class="skeleton" style="height:360px"></div></div><div class="col-lg-7"><div class="skeleton" style="height:360px"></div></div></div></div>`;

  const body = document.getElementById('profileBody');
  const load = async () => {
    try {
      body.innerHTML = profileHtml(await callApi('student.getProfile'));
    } catch (error) {
      if (error.code === 'NOT_SIGNED_IN') return void requireRole('student');
      body.innerHTML = `<div class="card">${errorStateHtml(error.message)}</div>`;
      body.querySelector('[data-action="retry"]').addEventListener('click', load);
    }
  };
  load();
}

function row(label, value) {
  return `<dt class="col-5 fw-normal text-secondary">${escapeHtml(label)}</dt><dd class="col-7 text-break">${value}</dd>`;
}

function profileHtml({ profile, account, classes }) {
  return `
    <div class="row g-3">
      <div class="col-lg-5">
        <div class="card h-100">
          <div class="card-body">
            <div class="d-flex align-items-center gap-3 mb-4">
              <span class="profile-avatar" aria-hidden="true">${escapeHtml(initials(profile.name))}</span>
              <div class="min-w-0">
                <div class="fs-5 fw-semibold">${escapeHtml(profile.name)}</div>
                <div class="text-secondary small">${escapeHtml(profile.student_number)}</div>
                <span class="badge rounded-pill ${profile.account_status === 'active' ? 'bg-success-subtle text-success-emphasis border border-success-subtle' : 'bg-secondary-subtle text-secondary-emphasis border'} mt-1">${profile.account_status === 'active' ? 'Active student' : escapeHtml(profile.account_status)}</span>
              </div>
            </div>
            <h3 class="h6 text-uppercase text-secondary small fw-semibold">Student information</h3>
            <dl class="row small mb-0">
              ${row('Program', `${escapeHtml(profile.program_code)}<div class="text-secondary">${escapeHtml(profile.program_name)}</div>`)}
              ${row('Year & section', `Year ${escapeHtml(profile.year_level)} · ${escapeHtml(profile.section_name)}`)}
              ${row('Email', escapeHtml(profile.email))}
            </dl>
            <h3 class="h6 text-uppercase text-secondary small fw-semibold mt-4">RFID card</h3>
            ${profile.card
              ? `<div class="rfid-card">
                  <div class="d-flex justify-content-between align-items-start">
                    <i class="bi bi-credit-card-2-front fs-3" aria-hidden="true"></i>
                    <span class="badge rounded-pill bg-success-subtle text-success-emphasis">Active</span>
                  </div>
                  <div class="font-monospace fs-5 mt-2">${escapeHtml(profile.card.rfid_uid_masked)}</div>
                  <div class="small opacity-75">Assigned ${escapeHtml(formatDateTime(profile.card.assigned_at))}</div>
                </div>`
              : '<p class="small text-secondary mb-0">No RFID card is assigned to you yet. Please see the administrator.</p>'}
            <h3 class="h6 text-uppercase text-secondary small fw-semibold mt-4">Sign-in account</h3>
            <dl class="row small mb-0">
              ${row('Account email', escapeHtml(account.email))}
              ${row('Last sign-in', account.last_login_at ? escapeHtml(formatDateTime(account.last_login_at)) : '—')}
            </dl>
          </div>
          <div class="card-footer bg-transparent small text-secondary">
            <i class="bi bi-info-circle me-1" aria-hidden="true"></i>Something wrong? Ask the administrator to update your details or replace a lost card.
          </div>
        </div>
      </div>
      <div class="col-lg-7">
        <div class="card h-100">
          <div class="card-header border-bottom">
            <h3 class="card-title-sm">Enrolled classes</h3>
            <span class="small text-secondary">${classes.length}</span>
          </div>
          ${classes.length
            ? classes.map((klass) => `
              <div class="subject-item">
                <div class="class-card-code">${escapeHtml(klass.subject_code)} · ${escapeHtml(klass.section_label)}</div>
                <div class="cell-main">${escapeHtml(klass.subject_title)}</div>
                <div class="cell-sub"><i class="bi bi-person-video3 me-1" aria-hidden="true"></i>${escapeHtml(klass.instructor_name)}</div>
                <div class="schedule-list small mt-2">${scheduleHtml(klass.schedules)}</div>
              </div>`).join('')
            : stateHtml({ icon: 'journal-x', title: 'Not enrolled in any class' })}
        </div>
      </div>
    </div>`;
}
