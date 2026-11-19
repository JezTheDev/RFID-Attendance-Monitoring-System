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
    actions.js         Action table: name -> { run, mode, role } + runAction() gate
                       (role: 'public' | 'any' | 'admin' | 'instructor' | 'student')
    auth/              passwords (hash/verify), context (ctx), session, account
                       (login/me/changePassword/logout), admin-users (reset/unlock,
                       new user rows), migration (migrate + bootstrap admin),
                       crypto-apps-script (Utilities adapter)
    utils.js           AppError, validation, Manila time, audit log, ids
    config.js          TIMEZONE only
    handlers/          academic, admins, classes, dashboard, instructors, portal, students
  seed/seed-data.json  FAKE test data (for a TEST Sheet only)
  tests/               node:test unit tests (+ helpers/db.js in-memory db, helpers/auth.js
                       node:crypto adapter + fake-clock ctx); server-gs.test.js runs the
                       real .gs files in a vm with a fake Sheet
  apps-script/
    Server.gs          Hand-written: calls RFID.runAction, Sheet read/write, editor-only
                       jobs (setupSheets, createBootstrapAdmin, migrateUsersToPasswordLogin,
                       benchmarkPasswordHash, checkSetup)
    Bundle.gs          GENERATED from backend/src — do not edit
    SeedData.gs        GENERATED from backend/seed/seed-data.json — do not edit
    appsscript.json    Manifest (Asia/Manila, V8)
frontend/              Static site (index.html = login; admin/, instructor/, student/)
  assets/js/           config.js (API_URL, TIMEZONE), api.js (callApi), auth, ui, pages/, components/
tools/
  build_apps_script.mjs   backend/src + seed JSON -> Bundle.gs + SeedData.gs
  xlsx_to_seed_data.py    docs/RFID_Test_Data.xlsx -> backend/seed/seed-data.json (needs openpyxl)
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
TEST Sheet only: `TEST_SEED_PASSWORD` (password of the fake seeded users);
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
7. Run `benchmarkPasswordHash` and `checkSetup`.
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
  (use `manilaNow()` from `backend/src/utils.js`).
- Handlers throw `AppError(code, message, fields?)`; Server.gs turns it into
  `{ ok:false, error:{ code, message, fields } }` and saves nothing.
- Bundle.gs must stay ES2020 (the build script refuses newer syntax).
- After editing anything in `backend/src`, run the build and the tests.
