# Production setup (real Sheet, real people)

Step-by-step for setting up the **real** system once. It takes about 30 minutes.
Follow the steps in order. For a TEST Sheet with fake data, use
`backend/README.md` instead.

> **Golden rules for the production Sheet**
> - **Never** set the `TEST_SEED_PASSWORD` Script Property. It marks a TEST Sheet.
> - **Never** run `setupSheets`, `issueTestDeviceKey`, `prepareLiveTest` or `cleanupLiveTest` here (they refuse or are for TEST only).
> - **Never** change `PASSWORD_PEPPER` after the first user exists. Every password would stop working.
> - **Never** share the Sheet with anyone, and never sort the raw tabs by hand (use the "View" tabs).
> - Get the school's approval before entering real student data.

## 0. Before you start

You need:
- the **project Google account** (the shared team account, not a personal one);
- this repository on a computer with Node.js;
- the latest code, tested and built:

  ```bash
  npm test                          # must say: fail 0
  node tools/build_apps_script.mjs  # writes backend/apps-script/Bundle.gs
  ```

## 1. Create the Sheet and its script

1. Sign in to Google as the **project account**.
2. Go to <https://sheets.google.com> and create a **blank** spreadsheet. Name it `RFID Attendance PRODUCTION`.
3. In the spreadsheet: **Extensions → Apps Script**. This opens a script project that belongs to this Sheet (a "bound" script). Name it `RFID Attendance PRODUCTION`.
4. In the Apps Script editor: **Project Settings** (gear icon) → tick **Show "appsscript.json" manifest file in editor**.

## 2. Keep the Sheet private

In the spreadsheet: **Share** →
- **General access: Restricted**. Never "Anyone with the link".
- People with access: only the project account. Optionally add one teacher as a backup owner.

The website and the RFID devices never open the Sheet. They talk to the script, which runs as the project account.

## 3. Copy the code

In the Apps Script editor:

1. Open `Code.gs`, delete everything in it, and rename it to `Server`. Paste all of `backend/apps-script/Server.gs`.
2. **+ → Script**, name it `Bundle`, and paste all of `backend/apps-script/Bundle.gs`.
3. Open `appsscript.json` and replace its contents with `backend/apps-script/appsscript.json`.
4. **Do NOT add `SeedData.gs`.** It holds the FAKE test people; production does not need it.
5. Save (Ctrl+S).

## 4. Script Properties (secrets)

**Project Settings → Script properties → Add script property.** These values never go into the repo, the Sheet, chat or screenshots.

1. **`PASSWORD_PEPPER`**: a **new** random secret, never the one from the TEST Sheet. Make it on your computer:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   Paste the 64 characters as the value. Keep one copy in the team's password manager: if the script project is ever lost, the passwords can only be checked with this exact value.
2. **`BOOTSTRAP_ADMIN_USERNAME`**: the first admin's username, e.g. `cpe.admin` (3–32 lowercase letters, numbers, `.`, `_` or `-`).
3. **`BOOTSTRAP_ADMIN_PASSWORD`**: a temporary password for that admin (at least 8 characters, letters and numbers). They must change it at the first sign-in.

Do **not** add `TEST_SEED_PASSWORD`.

## 5. Create the tabs: `setupEmptySheets`

1. In the editor's function dropdown choose **`setupEmptySheets`** → **Run**.
2. The first time, Google asks for permission: **Review permissions** → the project account → *"Google hasn't verified this app"* → **Advanced → Go to (project name)** → **Allow**.
3. The log (**Execution log**) lists every tab created. You now have:
   - every tab with its column names and plain-text cells, and **no rows**;
   - **Settings** filled with the default values (e.g. `roster_version = 1`, `duplicate_window_minutes = 5`, `low_battery_voltage = 3.5`);
   - the read-only **View - Attendance** and **View - Scans** tabs.

It is safe to run again: it only adds what is missing (a tab, a column, a Settings row) and never changes existing cells. A second run says "Nothing to change". If it says *"TEST_SEED_PASSWORD is set"*, delete that property: it does not belong here.

## 6. Create the first admin: `createBootstrapAdmin`

1. Function dropdown → **`createBootstrapAdmin`** → **Run**. The log says `Created admin "cpe.admin" …`.
2. **Right away:** Project Settings → Script properties → **delete `BOOTSTRAP_ADMIN_PASSWORD`** (you may delete `BOOTSTRAP_ADMIN_USERNAME` too).

It refuses if an active admin already exists. More admins are created later in the Admin portal.

## 7. Check: `checkSetup` (and `benchmarkPasswordHash`)

1. Run **`checkSetup`**. The **first line must be `Environment: PRODUCTION`**. Then:
   - `Users: 1`, `AuditLog: 1` (the bootstrap admin), `Settings: 11`, every other tab `0`;
   - `PASSWORD_PEPPER set: true`;
   - **no** warnings. If it warns that `BOOTSTRAP_ADMIN_PASSWORD` is still set, go back to step 6.
2. Optional: run **`benchmarkPasswordHash`**. One hash should take about 200–500 ms.

## 8. Publish the Web App

1. **Deploy → New deployment** → gear icon → **Web app**.
2. Description: `production v1`. **Execute as: Me** (the project account). **Who has access: Anyone**.
   "Anyone" is needed for the website and the ESP32 devices; every request is still checked by the code (password sessions, device keys).
3. **Deploy** → copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`).
4. Open that URL in a browser. You should see `{"ok":true,…,"status":"running"}`.

**Later code updates:** paste the new `Server.gs` / `Bundle.gs` → Save → **Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy**. The URL stays the same. Saving alone does **not** update the live Web App.

## 9. Point the website at production

1. In the repo, edit `frontend/assets/js/config.js`: set `API_URL` to the Web App URL from step 8.
2. Commit and push to the branch GitHub Pages publishes. After a minute the site uses the production backend.
3. Open the site and sign in with the bootstrap admin's username and the password from step 4. You must choose a new password right away.

## 10. Fill in the school data (Admin portal)

In this order, because each step needs the one before:

1. **Terms**: create the term, then **Set active**.
2. **Programs → Sections → Subjects → Rooms**.
3. **Instructors** and more **Admins**: each new account shows a **temporary password once**. Give it to the person privately; it expires after `temp_password_days` (7) and must be changed at the first sign-in.
4. **Students** (username = student number; temporary password as above), then **assign RFID cards**.
5. **Classes → schedules** (enrollment of the section is automatic; adjust if needed).

## 11. Register the RFID devices

For each reader, one per room. The Admin **Devices** page comes with the frontend phase; the backend actions already exist.

1. **Create device** (name + room). It starts in `maintenance`.
2. **Generate key**. The 64-character key is shown **once**. Put it in the firmware's `secrets.h` together with the `device_id` and the Web App URL. **Never** commit `secrets.h` or paste the key anywhere else.
3. Flash the reader, then **set the status to `active`**. Only one active device per room.
4. Check the dashboard: the device goes **online** after its first heartbeat.

A new key replaces the old one at once (re-flash the reader). A lost or broken reader: set it to `maintenance` or `retired` (retired is final and clears the key).

## Troubleshooting

| You see | Do this |
|---|---|
| `setupEmptySheets`: "TEST_SEED_PASSWORD is set" | Delete that Script Property; this is the production Sheet. |
| `createBootstrapAdmin`: `ADMIN_EXISTS` | An active admin already exists; sign in as them. |
| `createBootstrapAdmin`: `NOT_CONFIGURED` | Set `PASSWORD_PEPPER` and both `BOOTSTRAP_ADMIN_*` properties. |
| `checkSetup`: "roster_version is missing" | Run `setupEmptySheets` again (it adds missing Settings rows). |
| Website: every sign-in fails after a change | Did someone change `PASSWORD_PEPPER`? Put the original value back. |
| Website still shows old behavior | You saved but did not deploy a **new version** (step 8). |
