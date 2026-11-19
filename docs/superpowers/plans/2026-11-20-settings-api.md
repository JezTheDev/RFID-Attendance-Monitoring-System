# Admin Settings API + Lock Wait Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins can read and change the editable Settings rows through the API; the server lock wait drops to 10 s.

**Architecture:** One new handler file `backend/src/handlers/settings.js` with a frozen table of editable keys (range, whole/decimal, default description). Two actions in `actions.js`. `bumpRosterVersion` moves from `students.js` to `utils.js` so both handlers share it. `LOCK_WAIT_MS` is a one-line change in `Server.gs`.

**Tech Stack:** Node ES modules, `node:test`, Apps Script (Server.gs + generated Bundle.gs).

**Spec:** the task message (2026-11-20, "Admin Settings API + lower the lock wait"); CLAUDE.md; docs/PROJECT_CONTEXT.md ("Manage application settings").

## Global Constraints

- Branch `settings-api`. Backend only. Do not deploy.
- Editable keys, ranges (inclusive), whole numbers unless noted:
  `duplicate_window_minutes 0–60`, `early_window_minutes 0–60`, `accept_after_end_minutes 0–60`,
  `low_battery_voltage 3.00–4.20 (decimal, max 2 places)`, `device_offline_after_minutes 1–1440`,
  `heartbeat_interval_seconds 30–3600`, `session_token_hours 1–24`, `max_login_attempts 3–20`,
  `lockout_minutes 1–1440`, `temp_password_days 1–30`.
- `roster_version` and `late_grace_minutes` are never returned by `admin.getSettings` and are rejected by `admin.updateSettings` (VALIDATION_ERROR, like any unknown key). The `late_grace_minutes` row stays in the Sheet.
- All Sheet cells plain text: whole → `"15"`, decimal → 2 places `"3.50"`.
- Errors: `AppError` / `validationError(fields)`; fields keyed by setting key. Any error → nothing saved.
- Every action declares tabs; `tabs.test.js` must pass.
- `LOCK_WAIT_MS = 10000`.

## Review Focus

1. Value sent as a string (`"15"`, `"3.5"`) from a form → accepted same as a number. Test in Task 1.
2. Blank / `null` / `"abc"` / `"1e2"` / `" 5 "` / negative → VALIDATION_ERROR naming the key. Test in Task 1.
3. A Settings row missing in an older Sheet (e.g. `temp_password_days`) → `getSettings` shows `value: ''`; `updateSettings` adds the row. Test in Task 1.
4. Saving the same value again → no change, no audit row, no roster bump. Test in Task 1.
5. `changes` missing, not an object, an array, or `{}` → VALIDATION_ERROR on `changes`. Test in Task 1.

---

### Task 1: Settings handlers + actions

**Files:**
- Create: `backend/src/handlers/settings.js`
- Modify: `backend/src/utils.js` (add exported `bumpRosterVersion(db)`, moved from students.js)
- Modify: `backend/src/handlers/students.js:38-41` (delete local copy, import from utils)
- Modify: `backend/src/actions.js` (two entries)
- Test: `backend/tests/settings.test.js`

**Interfaces:**
- Produces: `EDITABLE_SETTINGS` (frozen `{ key: { min, max, decimal: bool, description } }`),
  `getSettings(db, request, session, ctx) -> { items: [{ key, value, description, min, max, decimal }] }` (table order; description from the Sheet row, else the table's),
  `updateSettings(db, { changes }, session, ctx) -> { items (same as getSettings), changed: [key…], roster_version_bumped: bool }`.
- Actions: `'admin.getSettings'` READ admin `reads: 'Settings'`; `'admin.updateSettings'` WRITE admin `writes: 'Settings', appends: 'AuditLog'`.

- [ ] **Step 1: Write failing tests** in `backend/tests/settings.test.js` (use `makeDb`, `SESSIONS`, `makeCtx`, `runAction` / direct calls as in `devices.test.js`):
  - `getSettings` returns exactly the 10 keys; no `roster_version`, no `late_grace_minutes`; each has `min`, `max`, `decimal`.
  - non-admin (instructor, student) via `runAction` → `FORBIDDEN`.
  - for every key: min and max accepted (stored as text, decimal key as `"3.00"`/`"4.20"`); min−1 and max+1 rejected (decimal key: `2.99`, `4.21`); whole-number keys reject `5.5`; `low_battery_voltage` rejects `3.555`.
  - string values `"15"` / `"3.5"` accepted → stored `"15"` / `"3.50"`; `''`, `null`, `'abc'`, `'1e2'`, `' 5 '`, `-1` rejected with `fields[key]`.
  - `{ duplicate_window_minutes: 10, max_login_attempts: 99 }` → VALIDATION_ERROR with `fields.max_login_attempts`, Settings deep-equal before, AuditLog empty.
  - `roster_version: 5`, `late_grace_minutes: 10`, `nope: 1` each → VALIDATION_ERROR naming that key.
  - `changes` missing / `[]` / `{}` / `'x'` → VALIDATION_ERROR with `fields.changes`.
  - roster_version: +1 after `duplicate_window_minutes` change; +1 (once) after `heartbeat_interval_seconds` + `duplicate_window_minutes` together; unchanged after `lockout_minutes`; unchanged when duplicate value saved equal to current.
  - one AuditLog row: `action 'UPDATE_SETTINGS'`, `entity_type 'Settings'`, `before_json` = `{"lockout_minutes":"15"}`, `after_json` = `{"lockout_minutes":"30"}` (only changed keys); no row when nothing changed.
  - missing row (`temp_password_days` absent from test db) → getSettings `value: ''`; update adds `{ key, value: '7', description, source: 'Admin settings' }`.

- [ ] **Step 2: Run** `node --test backend/tests/settings.test.js` → FAIL (module not found).

- [ ] **Step 3: Implement.** Parse: number → `String(n)`; then whole `/^\d+$/`, decimal `/^\d+(\.\d{1,2})?$/`; range check on `Number`; store whole as `String(Number(v))`, decimal as `Number(v).toFixed(2)`. Collect all errors first, throw before any write. Bump once if `duplicate_window_minutes` or `heartbeat_interval_seconds` is in `changed`. Audit via `writeAudit(db, session, { action: 'UPDATE_SETTINGS', entityType: 'Settings', entityId: 'Settings', before, after }, ctx)`.

- [ ] **Step 4: Run** `npm test` → all PASS (incl. `tabs.test.js`, `cards.test.js` still green after the move).

- [ ] **Step 5: Commit** `feat(settings): admin.getSettings / admin.updateSettings`.

### Task 2: Lock wait 10 s + docs + build

**Files:**
- Modify: `backend/apps-script/Server.gs:31` (`LOCK_WAIT_MS = 10000`)
- Modify: `docs/Device_API_Spec.md` §3.2 (server waits up to 10 s for the lock, then answers `SERVER_BUSY` — normally before the device's 20 s timeout; timeout and SERVER_BUSY still handled the same); `docs/AUDIT_REPORT.md:179` (`20 s wait` → `10 s wait`)
- Modify: `CLAUDE.md` (add the two actions + Settings rules in one short section)
- Test: `backend/tests/server-gs.test.js`

- [ ] **Step 1: Failing test** in server-gs.test.js: `assert.equal(makeServer().context.LOCK_WAIT_MS, 10000)`; plus `admin.updateSettings` through the real Server.gs saves the Settings row (and reads only Settings + AUTH_TABS + AuditLog header/last row).
- [ ] **Step 2: Run** → FAIL (20000).
- [ ] **Step 3:** Edit Server.gs and docs; `node tools/build_apps_script.mjs`.
- [ ] **Step 4: Verify** `npm test` all PASS; `node --check` on settings.js, utils.js, students.js, actions.js, Server.gs (copy to .js in scratchpad), Bundle.gs.
- [ ] **Step 5: Commit** `feat(server): lock wait 10 s; settings API docs`.
