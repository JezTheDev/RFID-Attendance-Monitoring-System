// Admin Settings: the editable rows of the Settings tab.
// roster_version (system) and late_grace_minutes (unused: a tap is always
// PRESENT) are left out on purpose; their rows stay in the Sheet.
import { validationError, writeAudit, bumpRosterVersion } from '../utils.js';

export const EDITABLE_SETTINGS = Object.freeze({
  duplicate_window_minutes: { min: 0, max: 60, decimal: false, description: 'Device double-tap cooldown (minutes)' },
  early_window_minutes: { min: 0, max: 60, decimal: false, description: 'Minutes before start when scans are accepted' },
  accept_after_end_minutes: { min: 0, max: 60, decimal: false, description: 'Minutes after end when scans are still accepted' },
  low_battery_voltage: { min: 3, max: 4.2, decimal: true, description: 'Dashboard low-battery threshold (V)' },
  device_offline_after_minutes: { min: 1, max: 1440, decimal: false, description: 'Device shown offline after no contact (minutes)' },
  heartbeat_interval_seconds: { min: 30, max: 3600, decimal: false, description: 'Device heartbeat interval (seconds)' },
  session_token_hours: { min: 1, max: 24, decimal: false, description: 'Web session lifetime (hours)' },
  max_login_attempts: { min: 3, max: 20, decimal: false, description: 'Failed sign-ins in a row before the account is locked' },
  lockout_minutes: { min: 1, max: 1440, decimal: false, description: 'How long a locked account stays locked (minutes)' },
  temp_password_days: { min: 1, max: 30, decimal: false, description: 'Days a temporary password (new account / reset) can be used' },
});

// Devices get these through device.getRoster, so a change bumps roster_version.
const ROSTER_KEYS = ['duplicate_window_minutes', 'heartbeat_interval_seconds'];
const WHOLE = /^\d+$/;
const DECIMAL = /^\d+(\.\d{1,2})?$/;

const isEditable = (key) => Object.prototype.hasOwnProperty.call(EDITABLE_SETTINGS, key);
const findRow = (db, key) => db.Settings.find((row) => row.key === key);

function rangeText({ min, max, decimal }) {
  return decimal
    ? `Use a number from ${min.toFixed(2)} to ${max.toFixed(2)} (up to 2 decimal places).`
    : `Use a whole number from ${min} to ${max}.`;
}

// Plain-text cell value, or null if the input is not allowed.
function parseValue(rule, input) {
  if (typeof input !== 'number' && typeof input !== 'string') return null;
  const text = String(input);
  if (!(rule.decimal ? DECIMAL : WHOLE).test(text)) return null;
  const number = Number(text);
  if (number < rule.min || number > rule.max) return null;
  return rule.decimal ? number.toFixed(2) : String(number);
}

export function getSettings(db) {
  return {
    items: Object.entries(EDITABLE_SETTINGS).map(([key, rule]) => {
      const row = findRow(db, key);
      return {
        key,
        value: row ? String(row.value) : '',
        description: (row && row.description) || rule.description,
        min: rule.min,
        max: rule.max,
        decimal: rule.decimal,
      };
    }),
  };
}

// All-or-nothing: every key is checked before anything changes.
export function updateSettings(db, input, session, ctx) {
  const changes = input.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) {
    throw validationError({ changes: 'Send at least one setting to change.' });
  }
  const errors = Object.create(null); // a "__proto__" key must land as a field, not set the prototype
  const values = {};
  Object.keys(changes).forEach((key) => {
    if (!isEditable(key)) {
      errors[key] = 'This setting cannot be changed.';
      return;
    }
    const value = parseValue(EDITABLE_SETTINGS[key], changes[key]);
    if (value === null) errors[key] = rangeText(EDITABLE_SETTINGS[key]);
    else values[key] = value;
  });
  if (Object.keys(errors).length) throw validationError(errors);

  const before = {};
  const after = {};
  Object.entries(values).forEach(([key, value]) => {
    const row = findRow(db, key);
    if (row && row.value !== '' && Number(row.value) === Number(value)) return;
    before[key] = row ? String(row.value) : '';
    after[key] = value;
    if (row) row.value = value;
    else db.Settings.push({ key, value, description: EDITABLE_SETTINGS[key].description, source: 'Admin settings' });
  });

  const changed = Object.keys(after);
  const rosterBumped = changed.some((key) => ROSTER_KEYS.includes(key));
  if (rosterBumped) bumpRosterVersion(db);
  if (changed.length) {
    writeAudit(db, session, { action: 'UPDATE_SETTINGS', entityType: 'Settings', entityId: 'Settings', before, after }, ctx);
  }
  return { ...getSettings(db), changed, roster_version_bumped: rosterBumped };
}
