// Production setup (I2): one schema for every tab, Settings defaults, and
// late_grace_minutes removed (a tap is always PRESENT; older Sheets may still have it).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDb, SESSIONS, CTX } from './helpers/db.js';
import { makeCtx } from './helpers/auth.js';
import { TAB_COLUMNS, DEFAULT_SETTINGS } from '../src/schema.js';
import { EDITABLE_SETTINGS, updateSettings } from '../src/handlers/settings.js';
import { USER_COLUMNS } from '../src/auth/admin-users.js';
import { createClass, updateClass, listClasses, getClass } from '../src/handlers/classes.js';
import * as migration from '../src/auth/migration.js';
import * as maintenance from '../src/maintenance.js';

const seed = JSON.parse(readFileSync(new URL('../seed/seed-data.json', import.meta.url), 'utf8'));

describe('schema (TAB_COLUMNS)', () => {
  it('the FAKE seed data uses exactly the schema tabs and columns', () => {
    assert.deepEqual(Object.keys(seed).sort(), Object.keys(TAB_COLUMNS).sort());
    for (const [tab, rows] of Object.entries(seed)) {
      rows.forEach((row) => assert.deepEqual(Object.keys(row), TAB_COLUMNS[tab], tab));
    }
  });

  it('Users columns are USER_COLUMNS', () => {
    assert.deepEqual(TAB_COLUMNS.Users, [...USER_COLUMNS]);
  });

  it('has no late_grace_minutes anywhere (schema, seed, defaults)', () => {
    assert.ok(!TAB_COLUMNS.Classes.includes('late_grace_minutes'));
    assert.ok(!JSON.stringify(seed).includes('late_grace_minutes'));
    assert.ok(!DEFAULT_SETTINGS.some((row) => row.key === 'late_grace_minutes'));
  });
});

describe('DEFAULT_SETTINGS', () => {
  it('= roster_version 1 + every editable key, each default valid for its own range', () => {
    assert.deepEqual(DEFAULT_SETTINGS.map((r) => r.key).sort(), ['roster_version', ...Object.keys(EDITABLE_SETTINGS)].sort());
    assert.equal(DEFAULT_SETTINGS.find((r) => r.key === 'roster_version').value, '1');
    DEFAULT_SETTINGS.forEach((row) => assert.deepEqual(Object.keys(row), TAB_COLUMNS.Settings, row.key));
    // Saving every default through admin.updateSettings is accepted (all in range).
    const db = makeDb();
    db.Settings = [];
    const changes = Object.fromEntries(DEFAULT_SETTINGS.filter((r) => r.key !== 'roster_version').map((r) => [r.key, r.value]));
    assert.equal(updateSettings(db, { changes }, SESSIONS.admin, CTX).changed.length, Object.keys(EDITABLE_SETTINGS).length);
  });

  it('the seed Settings rows are the defaults', () => {
    assert.deepEqual(seed.Settings, DEFAULT_SETTINGS);
  });
});

describe('late_grace_minutes is ignored', () => {
  it('createClass / updateClass do not store it, even if sent', () => {
    const db = makeDb();
    const ctx = makeCtx();
    const { class_id: id } = createClass(db, { term_id: 'TRM-0001', subject_id: 'SUB-0003', section_id: 'SEC-0001', instructor_id: 'INS-0001', late_grace_minutes: '99' }, SESSIONS.admin, ctx);
    assert.ok(!('late_grace_minutes' in db.Classes.find((c) => c.class_id === id)));
    updateClass(db, { class_id: 'CLS-0001', instructor_id: 'INS-0001', late_grace_minutes: 'abc' }, SESSIONS.admin, ctx); // no VALIDATION_ERROR
    assert.equal(db.Classes[0].late_grace_minutes, '15', 'an older Sheet keeps its value untouched');
  });

  it('class views never return it (older Sheet rows still have the column)', () => {
    const db = makeDb(); // fixture rows still carry late_grace_minutes
    assert.ok(listClasses(db).items.every((row) => !('late_grace_minutes' in row)));
    assert.ok(!('late_grace_minutes' in getClass(db, { class_id: 'CLS-0001' }).class));
  });
});

describe('removed one-time jobs', () => {
  it('migrateUsersToPasswordLogin and backfillOverrideReasons no longer exist', () => {
    assert.equal(migration.migrateUsersToPasswordLogin, undefined);
    assert.equal(maintenance.backfillOverrideReasons, undefined);
  });
});
