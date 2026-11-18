import { TIMEZONE } from './config.js';

const DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class AppError extends Error {
  constructor(code, message, fields = null) {
    super(message);
    this.code = code;
    this.fields = fields;
  }
}

export function validationError(fields) {
  return new AppError('VALIDATION_ERROR', 'Please correct the highlighted fields.', fields);
}

export function setting(db, key, fallback) {
  const row = db.Settings.find((item) => item.key === key);
  return row ? row.value : fallback;
}

export function manilaNow() {
  // On the Apps Script server, use its own date formatter (always available there).
  if (typeof Utilities !== 'undefined') {
    const now = new Date();
    const date = Utilities.formatDate(now, TIMEZONE, 'yyyy-MM-dd');
    const time = Utilities.formatDate(now, TIMEZONE, 'HH:mm');
    return { date, time, iso: `${date}T${Utilities.formatDate(now, TIMEZONE, 'HH:mm:ss')}+08:00` };
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((part) => [part.type, part.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    date,
    time: `${parts.hour}:${parts.minute}`,
    iso: `${date}T${parts.hour}:${parts.minute}:${parts.second}+08:00`,
  };
}

export function dayCodeOf(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  return DAY_CODES[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

export function isValidDate(dateString) {
  if (!DATE_PATTERN.test(dateString ?? '')) return false;
  const [year, month, day] = dateString.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export function shiftDate(dateString, days) {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function indexBy(rows, key) {
  return new Map(rows.map((row) => [row[key], row]));
}

export function fullName(person) {
  return person ? `${person.first_name} ${person.last_name}` : '';
}

export function cleanText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

export function writeAudit(db, session, { action, entityType, entityId, before = null, after = null, reason = '' }) {
  const number = db.AuditLog.length
    ? Math.max(...db.AuditLog.map((row) => Number(row.audit_id.slice(4)) || 0)) + 1
    : 1;
  db.AuditLog.push({
    audit_id: `AUD-${String(number).padStart(4, '0')}`,
    timestamp: manilaNow().iso,
    user_id: session.user_id,
    role: session.role,
    action,
    entity_type: entityType,
    entity_id: entityId,
    before_json: before ? JSON.stringify(before) : '',
    after_json: after ? JSON.stringify(after) : '',
    reason,
  });
}

export function nextId(rows, key, prefix, width = 4) {
  const highest = rows.reduce((max, row) => {
    const number = Number(String(row[key]).slice(prefix.length + 1));
    return Number.isFinite(number) && number > max ? number : max;
  }, 0);
  return `${prefix}-${String(highest + 1).padStart(width, '0')}`;
}
