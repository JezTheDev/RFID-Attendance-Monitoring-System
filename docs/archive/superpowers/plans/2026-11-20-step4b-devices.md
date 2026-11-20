# Step 4b Devices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin device management, one-time device keys, and the shared device authentication check.

**Architecture:** Handlers in `backend/src/handlers/devices.js` (same style as Rooms in academic.js); key hashing through `ctx` (`ctx.newDeviceKey()`, `ctx.deviceKeyHash(key)`); `authenticateDevice` + `runDeviceAction` in `backend/src/auth/device-auth.js`, wired into `actions.js` and a `device.*` branch in Server.gs.

**Tech Stack:** ES modules, node:test, Apps Script (bundled by tools/build_apps_script.mjs).

**Spec:** `docs/superpowers/specs/2026-11-20-step4b-devices-design.md`

## Global Constraints

- No npm dependencies; Bundle.gs stays ES2020.
- All cells plain text; timestamps via `toManilaIso(ctx.now())`.
- Never return/log/store the plain key; never return or audit `device_key_hash`.
- Every action declares its tabs; `tabs.test.js` must cover every action.

## Review Focus

1. A device row with an empty `device_key_hash` (seed rows) must never authenticate, even with an empty or blank key.
2. `device_id`/`device_key` sent as numbers, objects or arrays → `BAD_REQUEST`, never a crash.
3. A retired device can't be re-activated, re-assigned or given a key.
4. Activating a device in a room whose other device is in maintenance is allowed (only ACTIVE devices count).
5. Room codes with hyphens (`CPE-101`) still give a correct next id (`DEV-CPE-101-02`).

---

### Task 1: Device key crypto in ctx

**Files:** Modify `backend/src/auth/context.js`; Test `backend/tests/devices.test.js`

**Produces:** `ctx.newDeviceKey(): string` (64 lowercase hex), `ctx.deviceKeyHash(key): string` (64 hex = SHA-256 of `pepper + "\u0000" + key`, ONE round, with a comment explaining why).

- [ ] Test: key matches `/^[0-9a-f]{64}$/`, two keys differ, hash is deterministic, differs with another pepper, never equals the key.
- [ ] Run → fail; implement; run → pass.

### Task 2: Admin device handlers + action table

**Files:** Create `backend/src/handlers/devices.js`; Modify `backend/src/actions.js`, `backend/tests/tabs.test.js`; Test `backend/tests/devices.test.js`

**Produces:** `listDevices, createDevice, updateDevice, setDeviceStatus, assignDeviceRoom, generateDeviceKey` (each `run(db, request, session, ctx)`), `issueDeviceKey(db, ctx, device) -> string`, `DEVICE_STATUSES`.

Tabs: list reads `Devices Rooms`; create reads `Rooms`, writes `Devices`; update writes `Devices`; setStatus/assignRoom read `Rooms`, write `Devices`; generateKey writes `Devices`; all writes append `AuditLog`.

- [ ] Tests (devices.test.js): create → `DEV-CPE-101-01`, status maintenance, no hash; second create in same room → `-02`; ids not reused after retire; activate without key → `NO_DEVICE_KEY`; activate with key → active; activate second device in same room → `ROOM_HAS_ACTIVE_DEVICE` naming the first; assign active device into occupied room → same error; assign `''` unassigns; inactive/unknown room → validation error; retired is final + clears hash; key returned once, only hash stored, hash/key absent from AuditLog and listDevices; rotation replaces the hash; non-admin → `FORBIDDEN` for every `admin.*Device*` action.
- [ ] Add one representative case per new action to `tabs.test.js` CASES.
- [ ] Run → fail; implement; run → pass.

### Task 3: Device authentication + Server.gs route + editor helper

**Files:** Create `backend/src/auth/device-auth.js`; Modify `backend/src/actions.js` (export `runDeviceAction`, `DEVICE_TABS`), `backend/apps-script/Server.gs`; Test `backend/tests/devices.test.js`, `backend/tests/server-gs.test.js`

**Produces:** `authenticateDevice(db, request, ctx) -> device row`; `runDeviceAction(db, request, ctx)` (authenticates, then throws `UNKNOWN_ACTION`); `issueTestDeviceKey(db, ctx, deviceId) -> { device_id, device_key }` (refuses without `TEST_SEED_PASSWORD`, audits as system).

- [ ] Tests: right key → device; wrong key and unknown device → identical `INVALID_DEVICE_KEY` error (code + message); empty stored hash never matches; missing/non-string fields → `BAD_REQUEST`; maintenance/retired → `DEVICE_DISABLED`; no room → `DEVICE_NOT_ASSIGNED`; wrong key on a disabled device → `INVALID_DEVICE_KEY`; old key after rotation → `INVALID_DEVICE_KEY`.
- [ ] server-gs tests: `device.anything` with good key → `UNKNOWN_ACTION`, reads only `Devices`, writes nothing, no AuthSessions row; bad key → `INVALID_DEVICE_KEY`; key from `admin.generateDeviceKey` over doPost is in no Sheet cell and no log; `issueTestDeviceKey` refuses without `TEST_SEED_PASSWORD`, otherwise logs the key once and stores only the hash.
- [ ] Run → fail; implement; build; run → pass.

### Task 4: Docs, full verification, commit

- [ ] CLAUDE.md: device key hash choice, new actions, `issueTestDeviceKey` (test-only), `TEST_SEED_PASSWORD` must never be set on production. Server.gs header: same.
- [ ] `node tools/build_apps_script.mjs`, `npm test`, `node --check` on changed JS; commit on `step4b-devices`.
