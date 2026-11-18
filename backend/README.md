# Backend: Google Sheet + Apps Script

The website stores everything in **one Google Sheet**. The browser never opens the
Sheet directly. It sends requests to an **Apps Script Web App**, which checks who
is signed in, reads or writes the Sheet, and returns only what that person may see.

```
Website ──POST──▶ Apps Script Web App ──▶ Google Sheet (one tab per table)
```

## Files

| Path | What it is | Edit it? |
|---|---|---|
| `src/actions.js` | Table of every portal action: name → handler, read/write, required role | Yes |
| `src/handlers/*.js` | Business logic (students, cards, classes, schedules, portals, …). Pure functions on a `db` object | Yes |
| `src/utils.js` | `AppError`, validation helper, Manila time, audit log, ID numbers | Yes |
| `src/config.js` | `TIMEZONE` (Asia/Manila) | Rarely |
| `seed/seed-data.json` | **FAKE** test data for a TEST Sheet | Yes (or regenerate from the xlsx) |
| `tests/` | Unit tests (`npm test`) + `helpers/db.js` small fake db | Yes |
| `apps-script/Server.gs` | Routing, sign-in, sessions, reading/writing the Sheet, `setupSheets()` | Yes |
| `apps-script/Bundle.gs` | `src/` packed into one file for Apps Script. **Generated** | No — run the build |
| `apps-script/SeedData.gs` | `seed/seed-data.json` as `SEED_DATA`. **Generated** | No — run the build |
| `apps-script/appsscript.json` | Project settings (time zone, permissions, web app access) | Rarely |

Apps Script cannot load ES modules, so `tools/build_apps_script.mjs` wraps the
files in `src/` into `Bundle.gs`. After changing anything in `src/` or `seed/`:

```bash
npm test                          # make sure nothing broke
node tools/build_apps_script.mjs  # regenerate Bundle.gs and SeedData.gs
```

Then paste the new `Bundle.gs` into the Apps Script editor and **deploy a new version** (step 5).

### Fake test data

`seed/seed-data.json` holds fake records (`@example.com` emails, made-up names).
To change it, either edit the JSON, or edit `docs/RFID_Test_Data.xlsx` and run:

```bash
pip install openpyxl
python tools/xlsx_to_seed_data.py docs/RFID_Test_Data.xlsx
node tools/build_apps_script.mjs
```

Never put real student data or real/default passwords in the seed data.

---

## Setup (about 20 minutes, done once)

Use the **project Google account** that the whole team shares, not a personal
account. The Sheet and the script belong to it.

### 1. Create the Sheet and the script

1. Go to <https://sheets.google.com> and create a blank spreadsheet, e.g. `RFID Attendance TEST`.
2. In that spreadsheet: **Extensions → Apps Script**. A script project opens that is attached to this Sheet.
3. Click **Project Settings** (gear icon) → tick **Show "appsscript.json" manifest file in editor**.

### 2. Copy the code

In the Apps Script editor:

1. Open `Code.gs`, delete its contents, and rename it to `Server`. Paste all of `apps-script/Server.gs`.
2. **+ → Script** → name it `Bundle` → paste all of `apps-script/Bundle.gs`.
3. **+ → Script** → name it `SeedData` → paste all of `apps-script/SeedData.gs`.
4. Open `appsscript.json` → replace its contents with `apps-script/appsscript.json`.
5. Save (Ctrl+S).

### 3. Create the tabs

1. In the function dropdown choose **`setupSheets`** → **Run**.
2. The first time, Google asks for permission → **Review permissions** → choose the project account →
   *"Google hasn't verified this app"* → **Advanced → Go to (project name)** → **Allow**.
3. The Sheet now has 19 tabs (`Students`, `Attendance`, …).

`setupSheets()` creates missing tabs and fills **only empty tabs** with the FAKE
seed data. It never overwrites existing records. **Run it on a TEST spreadsheet
only** — on a real one, empty tabs would be filled with fake people.
Run **`checkSetup`** any time to log how many records each tab has.

**Rules for editing the Sheet by hand**
- Row 1 is the column names. Do not rename, reorder or delete them.
- All cells are plain text. Type dates as `2026-10-26` and times as `07:30` (24-hour).
- Prefer the website for changes: it checks for mistakes and writes the audit log. The Sheet does not.

### 4. Sign-in (temporary)

The real login (admin-created username/password accounts) is the **next step**
and is not built yet. Until then, only a **test sign-in** exists:
Script property `ALLOW_TEST_LOGIN = true` lets anyone sign in as the first
active admin/instructor/student in `Users` **without a password**.

> ⚠️ Only turn it on for a TEST Sheet with fake data, and delete the property
> when you are done. Never on a Sheet with real student data.

Google Sign-In is no longer used.

### 5. Deploy as a Web App

1. **Deploy → New deployment** → gear icon → **Web app**.
2. **Execute as:** *Me*. **Who has access:** *Anyone*.
   ("Anyone" is needed so the website and the RFID devices can reach it. The script itself refuses requests without a valid session.)
3. **Deploy** → copy the **Web app URL** (ends in `/exec`).
4. Open that URL in a browser. You should see `{"ok":true,...,"status":"running"}`.

**After every code change:** Deploy → **Manage deployments** → ✏️ edit → Version: **New version** → Deploy.
The URL stays the same. Saving the code alone does not update the live Web App.

### 6. Point the website to it

Put the URL in `frontend/assets/js/config.js` → `API_URL`. See `frontend/README.md` to run the site.

---

## How it works (short version)

- **Every request** carries a session token. The server finds it (stored as a SHA-256 hash in
  `AuthSessions`), checks it has not expired or been signed out, that the user is active and
  has the exact role the action needs (`src/actions.js`).
- **Ownership:** instructor and student actions take the person's ID from the session
  (`Users.linked_id`), never from the request, and only return their own classes and records.
- **Writes are locked** with `LockService`, so two saves at the same moment cannot overwrite each other.
- **Nothing is half-saved.** If an action throws an `AppError`, no tab is changed and the
  website gets `{ ok:false, error:{ code, message, fields } }`.
- **Absent is not stored.** It is computed: enrolled students minus those with a Present/Late row.

## Limits to keep in mind

- **Speed:** each request reads the Sheet (~1–3 s per page). Cache rarely-changing tabs if it gets slow.
- **Size:** max 10 million cells per spreadsheet. `Attendance`, `ScanLog`, `AuditLog` grow daily — archive per term.
- **Quotas:** Apps Script has daily runtime/request limits. Check them during a stress test.
- **Attendance corrections** to Absent currently delete the Attendance row (old value kept in
  `AuditLog`). Changing this to a `voided` flag is planned (audit ISS-07).

## Not done yet

- Username/password login (`auth.login`, change/reset password, lockout).
- RFID device endpoint (`device.submitScans`, `device.heartbeat`, `device.getRoster` in
  `docs/Device_API_Spec.md`) and the session engine (which class is in this room now, present vs late).
