# Backend: Google Sheet + Apps Script

The website stores everything in **one Google Sheet**. The browser never opens the
Sheet directly. It sends requests to an **Apps Script Web App**, which checks who
is signed in, reads or writes the Sheet, and returns only what that person may see.

```
Website ──POST──▶ Apps Script Web App ──▶ Google Sheet (one tab per table)
```

## Files

| File | What it is | Edit it? |
|---|---|---|
| `apps-script/Server.gs` | Routing, sign-in, sessions, reading/writing the Sheet, `setupSheets()` | Yes |
| `apps-script/Bundle.gs` | All portal actions (admin, instructor, student). **Generated** from `frontend/assets/js/demo/` | No: run the build |
| `apps-script/SeedData.gs` | FAKE test data used by `setupSheets()`. **Generated** | No |
| `apps-script/appsscript.json` | Project settings (time zone, permissions, web app access) | Rarely |

The portal logic is written **once**, in `frontend/assets/js/demo/handlers/`. Demo
mode runs it inside the browser; the backend runs the same code on Google's
servers. After changing any handler, rebuild:

```bash
node tools/build_apps_script.mjs
```

Then paste the new `Bundle.gs` into the Apps Script editor and **deploy a new version** (step 5).

---

## Setup (about 20 minutes, done once)

Use the **project Google account** that the whole team shares, not a personal
account (architecture doc, unresolved item #23). The Sheet and the script belong to it.

### 1. Create the Sheet and the script

1. Go to <https://sheets.google.com> and create a blank spreadsheet. Name it e.g. `RFID Attendance DB`.
2. In that spreadsheet: **Extensions → Apps Script**. A script project opens that is attached to this Sheet.
3. Click **Project Settings** (gear icon) → tick **Show "appsscript.json" manifest file in editor**.

### 2. Copy the code

In the Apps Script editor:

1. Open `Code.gs`, delete its contents, and rename it to `Server` (⋮ → Rename). Paste all of `apps-script/Server.gs`.
2. **+ → Script** → name it `Bundle` → paste all of `apps-script/Bundle.gs`.
3. **+ → Script** → name it `SeedData` → paste all of `apps-script/SeedData.gs`.
4. Open `appsscript.json` → replace its contents with `apps-script/appsscript.json`.
5. Save (Ctrl+S).

> Tip: if you prefer the command line, Google's `clasp` tool can push this folder instead of copy-pasting.

### 3. Create the tabs

1. In the function dropdown at the top, choose **`setupSheets`** → **Run**.
2. Google asks for permission the first time → **Review permissions** → choose the project account →
   *"Google hasn't verified this app"* → **Advanced → Go to (project name)** → **Allow**.
   (It is your own script, so this warning is expected.)
3. Go back to the Sheet: there are now 19 tabs (`Students`, `Attendance`, …) filled with the FAKE test data.

`setupSheets()` only fills **empty** tabs and never overwrites existing records, so it is safe to run again.
Run **`checkSetup`** any time to log how many records each tab has.

**Rules for editing the Sheet by hand**
- Row 1 is the column names. Do not rename, reorder or delete them.
- All cells are plain text on purpose. Type dates as `2026-10-26` and times as `07:30` (24-hour).
- Prefer the website for changes: it checks for mistakes (duplicate IDs, missing links) and writes the audit log. The Sheet does not.

### 4. Turn on test sign-in (temporary)

So the team can try everything before Google Sign-In is ready:

1. Apps Script → **Project Settings → Script properties → Add script property**
2. Property `ALLOW_TEST_LOGIN`, value `true` → Save.

This lets anyone with the website sign in as the first admin/instructor/student
in the `Users` tab. **Delete this property (or set it to `false`) before real use.**

### 5. Deploy as a Web App

1. **Deploy → New deployment** → gear icon → **Web app**.
2. Description: `v1`. **Execute as:** *Me*. **Who has access:** *Anyone*.
   ("Anyone" is needed so the website and the RFID devices can reach it. The script itself refuses requests without a valid session.)
3. **Deploy** → copy the **Web app URL** (it ends in `/exec`).
4. Open that URL in a browser. You should see `{"ok":true,...,"status":"running"}`.

**After every code change:** Deploy → **Manage deployments** → ✏️ edit → Version: **New version** → Deploy.
The URL stays the same. (Saving the code alone does not update the live Web App.)

### 6. Point the website to it

Edit `frontend/assets/js/config.js`:

```js
MODE: 'live',
API_URL: 'https://script.google.com/macros/s/XXXXXXXX/exec',
GOOGLE_CLIENT_ID: '',
TEST_LOGIN: true,
```

Run the site from a local server (not by double-clicking the file), e.g. in `frontend/`:

```bash
python -m http.server 5500
```

Open <http://localhost:5500>. The login page now shows **Test as Admin / Instructor / Student**.
Everything you do (for example correcting attendance or adding a student) appears in the Sheet.

To go back to fake in-browser data at any time: `MODE: 'demo'`.

---

## Real sign-in: Google Sign-In

Accounts are matched by **email** against the `Users` tab. Only emails listed there,
with `account_status = active`, can sign in. Nobody can register themselves.

1. Put real emails in the `Users` tab (or add people through the Admin portal).
   The test data uses `@example.com` addresses, which nobody can sign in with.
2. Go to <https://console.cloud.google.com> with the project account → create a project.
3. **APIs & Services → OAuth consent screen** → External → fill in the app name and support email.
   While the app is in *Testing*, add your team's emails as **Test users**.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** → *Web application*.
   Under **Authorized JavaScript origins** add every address the site is opened from, e.g.
   `http://localhost:5500` and your GitHub Pages address (`https://<user>.github.io`).
5. Copy the **Client ID** (`….apps.googleusercontent.com`) into:
   - Apps Script → Script properties → `GOOGLE_CLIENT_ID`
   - `frontend/assets/js/config.js` → `GOOGLE_CLIENT_ID`
6. A "Sign in with Google" button appears on the login page. On someone's first sign-in,
   their Google account ID is saved in `Users.google_sub`; later sign-ins must match it.
7. When everyone can sign in with Google: set `TEST_LOGIN: false` in `config.js`
   **and** delete `ALLOW_TEST_LOGIN` from the script properties.

---

## How it works (short version)

- **Every request** carries a session token. The script finds it (stored as a SHA-256 hash in the
  `AuthSessions` tab), checks it has not expired or been signed out, checks the user is active and
  has the right role. The instructor and student actions then only return that person's own classes
  and records (checked on the server, not just hidden in the page).
- **Writes are locked** with `LockService`, so two people saving at the same moment cannot overwrite each other.
- **Nothing is half-saved.** If an action fails (e.g. a validation error), no tab is changed.
- **New rows are appended**; a tab is rewritten only when existing rows changed.
- **Absent is not stored.** It is computed: enrolled students minus those with a Present/Late row.

## Limits to keep in mind

- **Speed:** each request reads the Sheet, so expect about 1–3 seconds per page load.
  Fine for one department; if it gets slow, cache the tables that rarely change.
- **Size:** a spreadsheet holds at most 10 million cells. `Attendance`, `ScanLog` and `AuditLog` grow
  every day. Plan to move each term's rows into an archive spreadsheet at term end.
- **Quotas:** Apps Script has daily limits on runtime and requests. Check them during a stress test.
- **Attendance corrections:** setting a student to Absent currently deletes their Attendance row
  (the old value is kept in `AuditLog`). The architecture doc prefers never deleting device rows;
  changing this to a `voided` flag is a good next step.

## Not done yet

- The **RFID device endpoint** (`device.scan`, `device.heartbeat`, `device.getRoster` in
  `docs/Device_API_Spec.md`). The ESP32 will POST to this same Web App URL; the session-resolution
  logic (which class is in this room right now, present vs late) still has to be written.
- The email/password form on the login page is not used (Google handles passwords).
