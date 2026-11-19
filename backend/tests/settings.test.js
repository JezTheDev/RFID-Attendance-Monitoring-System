// Admin Settings API: admin.getSettings / admin.updateSettings.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, SESSIONS, withCode } from './helpers/db.js';
import { makeCtx } from './helpers/auth.js';
import { getSettings, updateSettings, EDITABLE_SETTINGS } from '../src/handlers/settings.js';
import { runAction } from '../src/actions.js';
import { startSession } from '../src/auth/session.js';

const admin = SESSIONS.admin;

const RANGES = {
  duplicate_window_minutes: [0, 60],
  early_window_minutes: [0, 60],
  accept_after_end_minutes: [0, 60],
  low_battery_voltage: [3.00, 4.20],
  device_offline_after_minutes: [1, 1440],
  heartbeat_interval_seconds: [30, 3600],
  session_token_hours: [1, 24],
  max_login_attempts: [3, 20],
  lockout_minutes: [1, 1440],
  temp_password_days: [1, 30],
};

function setup() {
  const db = makeDb();
  db.Settings.push(
    { key: 'duplicate_window_minutes', value: '5', description: 'Device double-tap cooldown', source: '' },
    { key: 'heartbeat_interval_seconds', value: '300', description: '', source: '' },
    { key: 'low_battery_voltage', value: '3.5', description: '', source: '' },
    { key: 'late_grace_minutes', value: '15', description: '', source: '' },
  );
  return { db, ctx: makeCtx() };
}

const value = (db, key) => db.Settings.find((row) => row.key === key)?.value;
const update = (db, ctx, changes) => updateSettings(db, { changes }, admin, ctx);
const rejects = (db, ctx, changes, key) => assert.throws(() => update(db, ctx, changes), (error) => {
  withCode('VALIDATION_ERROR')(error);
  assert.ok(error.fields && key in error.fields, `fields should name ${key}: ${JSON.stringify(error.fields)}`);
  return true;
});

describe('admin.getSettings', () => {
  it('returns exactly the 10 editable keys with ranges, never roster_version or late_grace_minutes', () => {
    const { db, ctx } = setup();
    const { items } = getSettings(db, {}, admin, ctx);
    assert.deepEqual(items.map((i) => i.key).sort(), Object.keys(RANGES).sort());
    for (const item of items) {
      assert.deepEqual([item.min, item.max], RANGES[item.key], item.key);
      assert.equal(item.decimal, item.key === 'low_battery_voltage');
      assert.equal(typeof item.description, 'string');
      assert.ok(item.description.length > 0, item.key);
    }
    assert.equal(items.find((i) => i.key === 'duplicate_window_minutes').value, '5');
    assert.equal(items.find((i) => i.key === 'duplicate_window_minutes').description, 'Device double-tap cooldown');
  });

  it('a key with no Sheet row shows an empty value', () => {
    const { db, ctx } = setup();
    assert.equal(getSettings(db, {}, admin, ctx).items.find((i) => i.key === 'temp_password_days').value, '');
  });

  it('EDITABLE_SETTINGS matches the agreed ranges', () => {
    assert.deepEqual(Object.keys(EDITABLE_SETTINGS).sort(), Object.keys(RANGES).sort());
  });
});

describe('admin.updateSettings', () => {
  it('non-admins are rejected for both actions', () => {
    const { db, ctx } = setup();
    for (const userId of ['USR-0002', 'USR-0004']) {
      const { token } = startSession(db, db.Users.find((u) => u.user_id === userId), ctx);
      for (const action of ['admin.getSettings', 'admin.updateSettings']) {
        assert.throws(() => runAction(db, { action, session_token: token, changes: { lockout_minutes: 30 } }, ctx), withCode('FORBIDDEN'), action);
      }
    }
    assert.equal(value(db, 'lockout_minutes'), '15');
  });

  it('admin can call both through runAction', () => {
    const { db, ctx } = setup();
    const { token } = startSession(db, db.Users.find((u) => u.user_id === 'USR-0001'), ctx);
    runAction(db, { action: 'admin.updateSettings', session_token: token, changes: { lockout_minutes: 30 } }, ctx);
    const { items } = runAction(db, { action: 'admin.getSettings', session_token: token }, ctx);
    assert.equal(items.find((i) => i.key === 'lockout_minutes').value, '30');
  });

  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const decimal = key === 'low_battery_voltage';
    const step = decimal ? 0.01 : 1;
    const text = (n) => (decimal ? n.toFixed(2) : String(n));

    it(`${key}: min ${min} and max ${max} accepted`, () => {
      const { db, ctx } = setup();
      update(db, ctx, { [key]: min });
      assert.equal(value(db, key), text(min));
      update(db, ctx, { [key]: max });
      assert.equal(value(db, key), text(max));
    });

    it(`${key}: min-${step} and max+${step} rejected`, () => {
      const { db, ctx } = setup();
      rejects(db, ctx, { [key]: Math.round((min - step) * 100) / 100 }, key);
      rejects(db, ctx, { [key]: Math.round((max + step) * 100) / 100 }, key);
    });

    if (!decimal) {
      it(`${key}: decimals rejected`, () => {
        const { db, ctx } = setup();
        rejects(db, ctx, { [key]: min + 0.5 }, key);
        rejects(db, ctx, { [key]: `${min}.0` }, key);
      });
    }
  }

  it('low_battery_voltage: more than 2 decimal places rejected', () => {
    const { db, ctx } = setup();
    rejects(db, ctx, { low_battery_voltage: 3.555 }, 'low_battery_voltage');
  });

  it('numeric strings are accepted and stored as plain text', () => {
    const { db, ctx } = setup();
    update(db, ctx, { lockout_minutes: '20', low_battery_voltage: '3.6' });
    assert.equal(value(db, 'lockout_minutes'), '20');
    assert.equal(value(db, 'low_battery_voltage'), '3.60');
  });

  for (const bad of ['', null, 'abc', '1e2', ' 5 ', -1, true, [], {}]) {
    it(`value ${JSON.stringify(bad)} rejected`, () => {
      const { db, ctx } = setup();
      rejects(db, ctx, { lockout_minutes: bad }, 'lockout_minutes');
    });
  }

  it('one bad key: nothing saved, no audit row, error names only that key', () => {
    const { db, ctx } = setup();
    const before = JSON.stringify(db.Settings);
    assert.throws(() => update(db, ctx, { duplicate_window_minutes: 10, max_login_attempts: 99 }), (error) => {
      withCode('VALIDATION_ERROR')(error);
      assert.deepEqual(Object.keys(error.fields), ['max_login_attempts']);
      return true;
    });
    assert.equal(JSON.stringify(db.Settings), before);
    assert.equal(db.AuditLog.length, 0);
  });

  for (const key of ['roster_version', 'late_grace_minutes', 'nope', '__proto__']) {
    it(`${key} is not editable`, () => {
      const { db, ctx } = setup();
      const before = JSON.stringify(db.Settings);
      rejects(db, ctx, JSON.parse(`{"${key}": 5}`), key);
      assert.equal(JSON.stringify(db.Settings), before);
    });
  }

  for (const changes of [undefined, null, [], {}, 'x', 5]) {
    it(`changes ${JSON.stringify(changes)} rejected`, () => {
      const { db, ctx } = setup();
      assert.throws(() => updateSettings(db, { changes }, admin, ctx), (error) => {
        withCode('VALIDATION_ERROR')(error);
        assert.ok('changes' in error.fields);
        return true;
      });
    });
  }

  it('roster_version +1 when duplicate_window_minutes changes', () => {
    const { db, ctx } = setup();
    const result = update(db, ctx, { duplicate_window_minutes: 10 });
    assert.equal(value(db, 'roster_version'), '2');
    assert.equal(result.roster_version_bumped, true);
  });

  it('roster_version +1 once when both device keys change together', () => {
    const { db, ctx } = setup();
    update(db, ctx, { duplicate_window_minutes: 10, heartbeat_interval_seconds: 600 });
    assert.equal(value(db, 'roster_version'), '2');
  });

  it('roster_version unchanged for other keys', () => {
    const { db, ctx } = setup();
    const result = update(db, ctx, { lockout_minutes: 30, low_battery_voltage: 3.7, early_window_minutes: 5 });
    assert.equal(value(db, 'roster_version'), '1');
    assert.equal(result.roster_version_bumped, false);
  });

  it('saving the same value: no change, no audit row, no roster bump', () => {
    const { db, ctx } = setup();
    const result = update(db, ctx, { duplicate_window_minutes: '5', low_battery_voltage: 3.5 });
    assert.deepEqual(result.changed, []);
    assert.equal(value(db, 'roster_version'), '1');
    assert.equal(db.AuditLog.length, 0);
  });

  it('audit row holds before/after of the changed keys only', () => {
    const { db, ctx } = setup();
    const result = update(db, ctx, { lockout_minutes: 30, max_login_attempts: 5 });
    assert.deepEqual(result.changed, ['lockout_minutes']);
    assert.equal(db.AuditLog.length, 1);
    const row = db.AuditLog[0];
    assert.equal(row.action, 'UPDATE_SETTINGS');
    assert.equal(row.entity_type, 'Settings');
    assert.equal(row.user_id, admin.user_id);
    assert.deepEqual(JSON.parse(row.before_json), { lockout_minutes: '15' });
    assert.deepEqual(JSON.parse(row.after_json), { lockout_minutes: '30' });
  });

  it('a key with no Sheet row is added', () => {
    const { db, ctx } = setup();
    update(db, ctx, { temp_password_days: 7 });
    const row = db.Settings.find((r) => r.key === 'temp_password_days');
    assert.equal(row.value, '7');
    assert.equal(row.source, 'Admin settings');
    assert.ok(row.description.length > 0);
    assert.deepEqual(JSON.parse(db.AuditLog[0].before_json), { temp_password_days: '' });
  });

  it('returns the fresh list', () => {
    const { db, ctx } = setup();
    const { items } = update(db, ctx, { session_token_hours: 12 });
    assert.equal(items.find((i) => i.key === 'session_token_hours').value, '12');
  });
});
