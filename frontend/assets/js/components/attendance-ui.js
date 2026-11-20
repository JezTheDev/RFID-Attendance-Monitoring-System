// Small building blocks shared by the Instructor and Student portals.
import { escapeHtml, formatClockTime } from '../ui.js';

export const ATTENDANCE_STATUS = Object.freeze({
  present: { label: 'Present', tone: 'success', icon: 'check-circle' },
  late: { label: 'Late', tone: 'warning', icon: 'clock' },
  absent: { label: 'Absent', tone: 'danger', icon: 'x-circle' },
  not_scanned: { label: 'Not scanned yet', tone: 'secondary', icon: 'hourglass-split' },
  cancelled: { label: 'Class cancelled', tone: 'secondary', icon: 'slash-circle' },
});

export const SESSION_STATUS = Object.freeze({
  closed: { label: 'Completed', tone: 'success' },
  open: { label: 'Open', tone: 'primary' },
  cancelled: { label: 'Cancelled', tone: 'secondary' },
  scheduled: { label: 'Upcoming', tone: 'info' },
  in_progress: { label: 'In progress · no scans yet', tone: 'warning' },
  no_record: { label: 'No scans recorded', tone: 'warning' },
});

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

export function sessionBadge(status) {
  return badge(SESSION_STATUS[status] ?? { label: status, tone: 'secondary' });
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

// Builds a CSV file in the browser and starts the download.
export function downloadCsv(filename, rows) {
  const cell = (value) => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const csv = rows.map((row) => row.map(cell).join(',')).join('\r\n');
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
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
