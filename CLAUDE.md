# CLAUDE.md — RFID Attendance Monitoring System

IoT attendance for PSU Computer Engineering: **ESP32 + MFRC522 → Google Apps
Script Web App → private Google Sheet**. Static Bootstrap 5 site on GitHub
Pages with Admin, Instructor and Student portals. Current state and known
issues: `docs/AUDIT_REPORT.md`.

## Decisions (newer than any other doc in this repo)

- **Google Sign-In and test sign-in are REMOVED.** Login = admin-created
  accounts with username + password (instructor/admin: username; student:
  student number). Built in `backend/src/auth/` (Step 2). Login page polish,
  account Settings page and admin reset/unlock buttons are Step 3.
- **No sign-up, no email reset.** Admins create accounts and reset passwords;
  each gets a random **temporary password** (returned once as `temp_password`,
  never stored or logged, expires after `temp_password_days` = 7). The user
  must change it at the next sign-in. There are NO shared default passwords.
- **Demo mode is REMOVED.** No in-browser fake backend. The site talks to the
  live API only. Fake data exists only to fill a TEST Google Sheet.
- **No full rewrite.** Keep the existing handler logic: role checks,
  ownership checks (`linked_id` from the session, never from the request),
  LockService on writes, hashed session tokens.

## Folder layout

```
backend/
  src/                 Business logic (ES modules, pure functions on a db object)
    actions.js         Action table: name -> { run, mode, role, reads, writes, appends }
                       + runAction() gate, tabsFor(), guardDb()
                       (role: 'public' | 'any' | 'admin' | 'instructor' | 'student')
    maintenance.js     Editor-only jobs: backfillOverrideReasons, findScheduleClashes,
                       prepareLiveTest / cleanupLiveTest (TEST Sheet; marker = AuditLog
                       LIVE_TEST_SCHEDULE row)
    sessions.js        Session engine (pure): resolveScan (tap -> session decision, no writes),
                       sessionPhase, missingStatus ('not_scanned' until the end, then 'absent')
    auth/              passwords (hash/verify), context (ctx), session, account
                       (login/me/changePassword/logout), admin-users (reset/unlock,
                       new user rows), migration (migrate + bootstrap admin),
                       device-auth (authenticateDevice, issueTestDeviceKey),
                       crypto-apps-script (Utilities adapter)
    utils.js           AppError, validation, Manila time, audit log, ids
    config.js          TIMEZONE only
    handlers/          academic, admins, classes, dashboard, devices, instructors, portal, students
  seed/seed-data.json  FAKE test data (for a TEST Sheet only)
  tests/               node:test unit tests (+ helpers/db.js in-memory db, helpers/auth.js
                       node:crypto adapter + fake-clock ctx); server-gs.test.js runs the
                       real .gs files in a vm with a fake Sheet + Sheets API
                       (helpers/fake-apps-script.js, counts tabs/rows read and written);
                       tabs.test.js checks every action's tab declarations
  apps-script/
    Server.gs          Hand-written: calls RFID.runAction, Sheet read/write, editor-only
                       jobs (setupSheets, createBootstrapAdmin, migrateUsersToPasswordLogin,
                       backfillOverrideReasons, listScheduleClashes, benchmarkPasswordHash,
                       checkSetup, issueTestDeviceKey, prepareLiveTest,
                       cleanupLiveTest [last three: TEST Sheet only])
    Bundle.gs          GENERATED from backend/src — do not edit
    SeedData.gs        GENERATED from backend/seed/seed-data.json — do not edit
    appsscript.json    Manifest (Asia/Manila, V8)
frontend/              Static site (index.html = login; admin/, instructor/, student/)
  assets/js/           config.js (API_URL, TIMEZONE), api.js (callApi), auth, ui, pages/, components/
tools/
  build_apps_script.mjs   backend/src + seed JSON -> Bundle.gs + SeedData.gs
  xlsx_to_seed_data.py    docs/RFID_Test_Data.xlsx -> backend/seed/seed-data.json (needs openpyxl)
  measure_device_api.mjs  tabs/rows read + written per device.* action (fake Apps Script)
  live_device_test.mjs    step 4f: real device requests to the DEPLOYED Web App (env vars;
                          backend/README.md "Live test (4f)")
docs/                  Architecture, Device API spec, audit report, plans/specs
```

## Build and deploy the Apps Script

```bash
node tools/build_apps_script.mjs     # regenerates Bundle.gs and SeedData.gs
```

Then in the Apps Script editor: paste `Server.gs`, `Bundle.gs`, `SeedData.gs`
(and `appsscript.json` if changed) → Save → **Deploy → Manage deployments →
Edit → New version → Deploy**. Saving alone does not update the live Web App.
`setupSheets()` creates missing tabs and fills only EMPTY tabs with the fake
seed data — run it only on a TEST spreadsheet.

### Script Properties (values never in the repo)

`PASSWORD_PEPPER` (never change once set; the only required one); only for the
first admin: `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_PASSWORD` (delete after);
TEST Sheet only: `TEST_SEED_PASSWORD` (password of the fake seeded users). It is
also the **test-Sheet marker** (`issueTestDeviceKey` refuses without it), so it
must **never** be set on the production Sheet;
optional `SPREADSHEET_ID`. Obsolete (safe to delete): `GOOGLE_CLIENT_ID`,
`ALLOW_TEST_LOGIN`, `DEFAULT_STUDENT_PASSWORD`, `DEFAULT_INSTRUCTOR_PASSWORD`,
`DEFAULT_ADMIN_PASSWORD`.

### Moving a deployed Sheet to password login (in this order)

1. `npm test` and `node tools/build_apps_script.mjs`.
2. Google Sheets: **File → Make a copy** of the live spreadsheet (backup).
3. Script Properties: add the pepper; delete `GOOGLE_CLIENT_ID` and `ALLOW_TEST_LOGIN`.
4. Paste `Server.gs`, `Bundle.gs`, `SeedData.gs`, `appsscript.json` → Save.
5. Run `migrateUsersToPasswordLogin` (log lists every change; rerun = "Nothing to change").
   Users without a password get none; an admin resets each (temporary password).
6. If there is no active admin: set the two `BOOTSTRAP_ADMIN_*` properties, run
   `createBootstrapAdmin`, then delete `BOOTSTRAP_ADMIN_PASSWORD`.
7. Run `benchmarkPasswordHash` and `checkSetup` (also warns if Settings
   `roster_version` is missing/< 1 or `low_battery_voltage` is empty/not a number).
   After deploying step 4a (tab declarations) also run `backfillOverrideReasons`
   once (copies old correction reasons into Attendance) and `listScheduleClashes`
   (read-only report).
8. Deploy → Manage deployments → Edit → New version → Deploy.
9. Publish the frontend (GitHub Pages) — the old site cannot sign in anymore.

## Auth rules (backend/src/auth)

- Hash: `v1$<iterations>$<salt>$<hash>`, salt per user + pepper, iterated
  SHA-256 (`PASSWORD_HASH_ITERATIONS` = 300 in passwords.js, measured
  1.197 ms/iteration in Apps Script ≈ 360 ms/hash; raising it re-hashes at next
  login, lowering it does not — higher-count hashes still verify, just slower,
  until the password is changed or reset). Handlers hash through `ctx` (`ctx.hash`, `ctx.verify`,
  `ctx.newTempPassword()`, `ctx.now()`), never `Utilities` directly. New/reset
  accounts go through `issueTempPassword(db, ctx, user)` (admin-users.js).
- Login with an expired temporary password → `TEMP_PASSWORD_EXPIRED` (checked
  only after the password is right). changePassword clears `temp_password_expires_at`.
- Handlers are `run(db, request, session, ctx)`. `session` has `user_id`,
  `role`, `username`, `must_change_password`, `token_hash` (server-only).
- Same `INVALID_CREDENTIALS` for unknown user / wrong password; lockout after
  `max_login_attempts` for `lockout_minutes` (Settings). Failed logins throw
  with `error.commit = true` so Server.gs still saves the counter and audit row.
- `must_change_password` TRUE → only `auth.me`, `auth.changePassword`,
  `auth.logout` (`PASSWORD_CHANGE_REQUIRED` otherwise).
- Never return or log a password or `password_hash`; tests check responses.
  Only exception: `temp_password` in the create/reset response data.

## Devices and device keys (step 4b)

- Admin actions: `admin.listDevices`, `createDevice {device_name, room_id, notes?}`,
  `updateDevice {device_id, device_name, notes?}`, `setDeviceStatus` (active /
  maintenance / retired), `assignDeviceRoom` (`room_id: ''` unassigns),
  `generateDeviceKey`. No delete. `device_id` = `DEV-<room_code>-NN`, never reused
  or renamed. New devices start in `maintenance`; retired is final and clears the key.
- Only ONE **active** device per room (`ROOM_HAS_ACTIVE_DEVICE` names it);
  activating needs a key (`NO_DEVICE_KEY`).
- Key = 32 random bytes as 64 hex characters, returned ONCE as `device_key`
  (same rule as `temp_password`: never in a Sheet cell, AuditLog or log). A new
  key replaces the old one at once. `device_key_hash` never leaves the server
  (lists show `has_key`) and is never put in the AuditLog.
- Hash = **one** SHA-256 of `PASSWORD_PEPPER + " " + key` (`ctx.deviceKeyHash`),
  NOT the 300-iteration password hash: the key is long and random, so it cannot
  be guessed, and every tap stays fast (the password hash costs ~360 ms).
- `device.*` requests: same Server.gs path as user actions (declared tabs from
  `DEVICE_ACTIONS` / `deviceTabsFor`, lock for writes, one batchUpdate) but
  `RFID.runDeviceAction` → `authenticateDevice` instead of a user session.
  The key is checked first: unknown device or wrong key → `INVALID_DEVICE_KEY`
  (same error), then `DEVICE_DISABLED` (not active), `DEVICE_NOT_ASSIGNED`.
  Missing fields → `BAD_REQUEST`. Unknown `device.*` → `UNKNOWN_ACTION` (after
  the key check, loads only `Devices`). Busy lock → `SERVER_BUSY`.
- `device.submitScans` (step 4d, `handlers/device.js`): 1–20 scans; bad item →
  `BAD_REQUEST` for all; `scan_id` must start with the device's own id; resent
  `scan_id` → `ALREADY_RECORDED` + `original_result`, no rows; every new scan →
  one ScanLog row; ACCEPTED → new session (if any) + Attendance. Reads
  ScanLog and Attendance fully (idempotency + DUPLICATE).
- `device.heartbeat` (4e): validates battery_voltage 0–6, wifi_rssi −127..0,
  queue_count/uptime_seconds integers ≥ 0, time_synced boolean, firmware_version
  1–32 chars (else `BAD_REQUEST`); updates ONLY its own Devices row (1 row, under
  the lock), **no AuditLog row**. Returns `roster_version`, `low_battery`
  (stored 2-decimal voltage < `low_battery_voltage`).
- `device.getRoster` (4e): read-only, no lock. `known_version` == current →
  `{changed:false, roster_version}`; else active cards of active students
  (`{uid, name}`, name ≤ 16 chars) + `duplicate_window_minutes`,
  `heartbeat_interval_seconds`.
- **roster_version** must be bumped by every change to roster content: card
  assign/replace/revoke, any student status change, student first/last name change.
- Rows read/written per device action: `node tools/measure_device_api.mjs`.
- `server_time` in every reply is Manila ISO `+08:00` (`serverTime_()`, same
  clock as `ctx.now()`).
- `issueTestDeviceKey(device_id)` (editor-only, **TEST Sheet only**) logs a new
  key once for firmware tests; production keys come from the Admin portal.

## Tests

```bash
npm test            # same as: node --test
```

No npm dependencies. Tests build a small in-memory db
(`backend/tests/helpers/db.js`) and call handlers directly.
Also run `node --check <file>` on changed JS files.

## Coding rules

- **No fake success responses.** If something is not implemented, return an
  error (`NOT_IMPLEMENTED`), never `ok: true` with made-up data.
- **Auth and roles are enforced on the backend only.** Frontend checks are for
  navigation. Instructor/student handlers must derive identity from the
  session (`linked_id`), never from request fields.
- **Never store plaintext passwords.** Salted + iterated hash only.
- **Never commit secrets** (default passwords, device keys, Wi-Fi passwords,
  `secrets.h`). Secrets live in Apps Script Script Properties.
- **All Sheet cells are plain text.** Dates `YYYY-MM-DD`, times `HH:mm` (24h).
- **Time zone is Asia/Manila.** Timestamps are ISO with `+08:00`
  (`toManilaIso(ctx.now())` / `manilaAt(ctx.now())` from `backend/src/utils.js`; ctx.now() is the one clock, also for `writeAudit(db, session, entry, ctx)`).
- Handlers throw `AppError(code, message, fields?)`; Server.gs turns it into
  `{ ok:false, error:{ code, message, fields } }` and saves nothing.
- Bundle.gs must stay ES2020 (the build script refuses newer syntax).
- After editing anything in `backend/src`, run the build and the tests.
- **Every action declares its tabs** in `actions.js`: `reads` (loaded fully),
  `writes` (may change), `appends` (append-only: only header + last row are
  loaded, e.g. AuditLog). Server.gs loads only those (one `values.batchGet`)
  and saves every change in ONE `spreadsheets.batchUpdate` (all-or-nothing;
  edited rows written alone, new rows appended). `tabs.test.js` fails on an
  undeclared tab; the live site loads it anyway and logs a warning.
- Never sort the raw tabs by hand (use the "View - …" tabs): append tabs take
  the next id from the LAST row.
- Correction reasons live in `Attendance.override_reason`; the portals never
  read AuditLog.
