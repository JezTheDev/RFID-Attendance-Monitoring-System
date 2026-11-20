// Small building blocks shared by the Instructor and Student portals.
import { escapeHtml, formatClockTime, formatTimestamp, stateHtml } from '../ui.js';

export const ATTENDANCE_STATUS = Object.freeze({
  present: { label: 'Present', tone: 'success', icon: 'check-circle' },
  late: { label: 'Late', tone: 'warning', icon: 'clock' },
  absent: { label: 'Absent', tone: 'danger', icon: 'x-circle' },
  not_scanned: { label: 'Not yet', tone: 'secondary', icon: 'hourglass-split' },
  cancelled: { label: 'Class cancelled', tone: 'secondary', icon: 'slash-circle' },
});

// Backend `phase` (sessionPhase). A real session stays status "open" after it
// ends, so labels always come from phase; a session row exists only after the first tap.
export const SESSION_PHASE = Object.freeze({
  upcoming: { label: 'Upcoming', tone: 'info' },
  in_progress: { label: 'In progress', tone: 'primary' },
  ended: { label: 'Completed', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'secondary' },
});

const LIVE_PHASES = ['upcoming', 'in_progress'];

const DAY_LABELS = { MON: 'Mon', TUE: 'Tue', WED: 'Wed', THU: 'Thu', FRI: 'Fri', SAT: 'Sat', SUN: 'Sun' };

export function badge({ label, tone, icon = '' }) {
  const classes = tone === 'primary'
    ? 'text-bg-primary'
    : `bg-${tone}-subtle text-${tone}-emphasis border border-${tone}-subtle`;
  const iconHtml = icon ? `<i class="bi bi-${icon} me-1" aria-hidden="true"></i>` : '';
  return `<span class="badge rounded-pill ${classes}">${iconHtml}${escapeHtml(label)}</span>`;
}

export function attendanceBadge(status) {
  return badge(ATTENDANCE_STATUS[status] ?? { label: status, tone: 'secondary' });
}

export function phaseBadge(row) {
  if (row.session_id === null && row.phase === 'in_progress') return badge({ label: 'In progress · no scans yet', tone: 'warning' });
  if (row.session_id === null && row.phase === 'ended') return badge({ label: 'No scans recorded', tone: 'warning' });
  return badge(SESSION_PHASE[row.phase] ?? { label: row.phase, tone: 'secondary' });
}

// Short text for a session in a picker.
export function sessionOptionLabel(row) {
  if (row.phase === 'cancelled') return 'Cancelled';
  if (row.phase === 'upcoming') return 'Upcoming';
  const attended = `${row.present + row.late}/${row.enrolled}`;
  return row.phase === 'in_progress' ? `In progress · ${attended} in` : `${attended} attended`;
}

// [value, label, count] filter buttons. "Not yet" (no tap) only while the class
// can still be tapped into; after the end those students are absent.
export function statusFilters(info, students) {
  const count = (status) => students.filter((row) => row.status === status).length;
  return [
    ['all', 'All', students.length],
    ['present', 'Present', count('present')],
    ['late', 'Late', count('late')],
    ...(LIVE_PHASES.includes(info.phase) ? [['not_scanned', 'Not yet', count('not_scanned')]] : []),
    ['absent', 'Absent', count('absent')],
  ];
}

// Instructor dashboard card for instructor.getRecentActivity; linkFor(item) -> session URL.
export function recentActivityHtml({ limit, has_more: hasMore, items }, linkFor) {
  const tags = (row) => [
    row.corrected ? '<span class="badge text-bg-light border"><i class="bi bi-pencil-square me-1" aria-hidden="true"></i>Corrected</span>' : '',
    !row.corrected && row.source === 'manual' ? '<span class="badge text-bg-light border">Manual</span>' : '',
    row.sync_mode === 'offline' ? '<span class="badge text-bg-light border"><i class="bi bi-cloud-arrow-up me-1" aria-hidden="true"></i>Offline sync</span>' : '',
  ].join('');
  const body = items.length
    ? `<div class="list-group list-group-flush">${items.map((row) => `
        <a class="list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-2" href="${escapeHtml(linkFor(row))}">
          <div class="min-w-0">
            <div class="cell-main text-truncate">${escapeHtml(row.student_name)}</div>
            <div class="cell-sub">${escapeHtml(row.class_label)} · ${escapeHtml(formatDateShort(row.session_date))} · ${escapeHtml(formatTimestamp(row.scanned_at))}</div>
          </div>
          <div class="d-flex flex-wrap justify-content-end gap-1">${attendanceBadge(row.status)}${tags(row)}</div>
        </a>`).join('')}</div>`
    : stateHtml({ icon: 'broadcast', title: 'No attendance yet', message: 'Taps and corrections in your classes will appear here.' });
  return `
    <div class="card">
      <div class="card-header border-bottom">
        <h3 class="card-title-sm">Recent activity</h3>
        <span class="small text-secondary">${hasMore ? `Showing the latest ${escapeHtml(limit)}` : 'Your active classes'}</span>
      </div>
      ${body}
    </div>`;
}

// Optional {from, to} filter (YYYY-MM-DD, inclusive) as the backend echoes it in `range`.
export function rangeText(range) {
  const { from, to } = range ?? {};
  if (!from && !to) return 'Whole term';
  if (from && to) return `${formatDateShort(from)} – ${formatDateShort(to)}`;
  return from ? `From ${formatDateShort(from)}` : `Up to ${formatDateShort(to)}`;
}

// The from/to messages of a VALIDATION_ERROR (bad date, from > to, > 366 days), or null.
export function dateFieldErrors(error) {
  const fields = {};
  ['from', 'to'].forEach((key) => { if (error?.fields?.[key]) fields[key] = error.fields[key]; });
  return Object.keys(fields).length ? fields : null;
}

// From / To / Whole term inputs for a filter <form>; showFieldErrors() fills the error boxes.
export function rangeInputsHtml({ from = '', to = '' } = {}) {
  const input = (name, label, value) => `
    <div class="col-6 col-lg-3">
      <label class="form-label small text-secondary mb-1" for="${name}Date">${label}</label>
      <input type="date" class="form-control" id="${name}Date" name="${name}" value="${escapeHtml(value)}">
      <div class="invalid-feedback" data-error-for="${name}"></div>
    </div>`;
  return `${input('from', 'From', from)}${input('to', 'To', to)}
    <div class="col-12 col-lg-2 d-grid">
      <button type="button" class="btn btn-light border" data-range-clear>Whole term</button>
    </div>`;
}

// A class from the URL that is not (or no longer) the instructor's: drop it and show their
// own classes instead of a "Try again" that repeats the same refusal.
export function unknownClassError(error, classId) {
  return Boolean(classId) && ['FORBIDDEN', 'NOT_FOUND'].includes(error?.code);
}

// <option>s for an instructor class picker: active classes, then a read-only
// "Past / inactive classes" group.
export function classOptionsHtml(classes, pastClasses, selectedId) {
  const option = (c, suffix = '') => `<option value="${escapeHtml(c.class_id)}"${c.class_id === selectedId ? ' selected' : ''}>${escapeHtml(c.class_label + suffix)}</option>`;
  if (!classes.length && !pastClasses?.length) return '<option value="">No classes assigned</option>';
  const past = pastClasses?.length
    ? `<optgroup label="Past / inactive classes (read-only)">${pastClasses.map((c) => option(c, c.term_name ? ` · ${c.term_name}` : '')).join('')}</optgroup>`
    : '';
  return classes.map((c) => option(c)).join('') + past;
}

// UI only; the server refuses too (SESSION_CANCELLED, SESSION_NOT_STARTED, CLASS_INACTIVE).
export function canCorrect(info, klass) {
  return info.phase !== 'cancelled' && info.phase !== 'upcoming' && klass.status === 'active';
}

export function formatRate(rate) {
  return rate === null || rate === undefined ? '—' : `${Math.round(rate * 100)}%`;
}

export function rateTone(rate) {
  if (rate === null || rate === undefined) return 'secondary';
  if (rate >= 0.9) return 'success';
  if (rate >= 0.8) return 'warning';
  return 'danger';
}

export function rateMeterHtml(rate, label = 'Attendance rate') {
  const percent = rate === null || rate === undefined ? 0 : Math.round(rate * 100);
  return `
    <div class="rate-meter rate-${rateTone(rate)}" role="img" aria-label="${escapeHtml(label)}: ${formatRate(rate)}">
      <span style="width:${percent}%"></span>
    </div>`;
}

export function statCard({ icon, label, value, hint, gold = false, col = 'col-6 col-xl-3' }) {
  return `
    <div class="${col}">
      <div class="card stat-card h-100">
        <div class="card-body">
          <div class="stat-icon${gold ? ' gold' : ''}" aria-hidden="true"><i class="bi bi-${icon}"></i></div>
          <div class="min-w-0">
            <div class="stat-label">${escapeHtml(label)}</div>
            <div class="stat-value">${escapeHtml(value)}</div>
            <div class="stat-hint">${escapeHtml(hint)}</div>
          </div>
        </div>
      </div>
    </div>`;
}

export function countsBarHtml({ present, late, enrolled, absent }) {
  if (present === null || present === undefined || !enrolled) return '';
  const percent = (value) => (value / enrolled) * 100;
  return `<div class="att-bar" role="img" aria-label="${present} present, ${late} late, ${absent} absent of ${enrolled}">
      <span class="present" style="width:${percent(present)}%"></span><span class="late" style="width:${percent(late)}%"></span>
    </div>`;
}

export function formatDateShort(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    .format(new Date(Date.UTC(year, month - 1, day)));
}

export function scheduleHtml(schedules) {
  if (!schedules?.length) return '<span class="text-secondary">No schedule set</span>';
  return schedules.map((slot) => `
    <span class="schedule-chip">
      <strong>${escapeHtml(DAY_LABELS[slot.day] ?? slot.day)}</strong>
      ${escapeHtml(formatClockTime(slot.start_time))}–${escapeHtml(formatClockTime(slot.end_time))}
      <span class="text-secondary">· ${escapeHtml(slot.room_code)}</span>
    </span>`).join('');
}

export function scheduleText(schedules) {
  return (schedules ?? []).map((slot) => `${DAY_LABELS[slot.day] ?? slot.day} ${formatClockTime(slot.start_time)}–${formatClockTime(slot.end_time)} (${slot.room_code})`).join(', ');
}

// CSV text with a UTF-8 BOM (so Excel reads names correctly). A cell starting
// with = + - @ gets a leading ' so a spreadsheet never runs it as a formula.
export function csvText(rows) {
  const cell = (value) => {
    let text = String(value ?? '');
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `﻿${rows.map((row) => row.map(cell).join(',')).join('\r\n')}`;
}

// Builds a CSV file in the browser and starts the download.
export function downloadCsv(filename, rows) {
  const blob = new Blob([csvText(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function loadingCardsHtml(heights = [96, 96, 96, 96], big = [320, 320]) {
  const block = (height) => `<div class="skeleton" style="height:${height}px"></div>`;
  return `
    <div class="row g-3 mb-3" aria-busy="true" aria-label="Loading">
      ${heights.map((h) => `<div class="col-6 col-xl-3">${block(h)}</div>`).join('')}
    </div>
    <div class="row g-3">
      <div class="col-xl-8">${block(big[0])}</div>
      <div class="col-xl-4">${block(big[1])}</div>
    </div>`;
}

// Reads ?key=value from the address bar, and updates it without reloading.
export function getParam(name) {
  return new URLSearchParams(window.location.search).get(name) ?? '';
}

export function setParams(values) {
  const params = new URLSearchParams(window.location.search);
  Object.entries(values).forEach(([key, value]) => {
    if (value) params.set(key, value);
    else params.delete(key);
  });
  const query = params.toString();
  history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
}
