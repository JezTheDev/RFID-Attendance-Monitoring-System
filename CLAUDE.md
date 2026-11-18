# CLAUDE.md — RFID Attendance Monitoring System

IoT attendance for PSU Computer Engineering: **ESP32 + MFRC522 → Google Apps
Script Web App → private Google Sheet**. Static Bootstrap 5 site on GitHub
Pages with Admin, Instructor and Student portals. Current state and known
issues: `docs/AUDIT_REPORT.md`.

## Decisions (newer than any other doc in this repo)

- **Google Sign-In is REMOVED.** New login = admin-created accounts with
  username + password (instructor: username; student: student number).
  Not built yet — until it is, the old `auth.testSignIn` / `auth.google` code
  is still there and will be deleted when `auth.login` lands.
- **Demo mode is REMOVED.** No in-browser fake backend. The site talks to the
  live API only. Fake data exists only to fill a TEST Google Sheet.
- **No full rewrite.** Keep the existing handler logic: role checks,
  ownership checks (`linked_id` from the session, never from the request),
  LockService on writes, hashed session tokens.

## Folder layout

```
backend/
  src/                 Business logic (ES modules, pure functions on a db object)
    actions.js         Action table: name -> { run, mode: read|write, role }
    utils.js           AppError, validation, Manila time, audit log, ids
    config.js          TIMEZONE only
    handlers/          academic, admins, classes, dashboard, instructors, portal, students
  seed/seed-data.json  FAKE test data (for a TEST Sheet only)
  test/                node:test unit tests (+ helpers/db.js in-memory db)
  apps-script/
    Server.gs          Hand-written: router, auth/sessions, Sheet read/write, setupSheets
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

## Tests

```bash
npm test            # same as: node --test
```

No npm dependencies. Tests build a small in-memory db
(`backend/test/helpers/db.js`) and call handlers directly.
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
