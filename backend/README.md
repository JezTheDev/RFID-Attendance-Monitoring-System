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
| `src/actions.js` | Table of every action (name → handler, read/write, role) and `runAction()`, the gate every request goes through | Yes |
| `src/auth/*.js` | Login, sessions, password hashing, reset/unlock, migration, bootstrap admin | Yes |
| `src/handlers/*.js` | Business logic (students, cards, classes, schedules, portals, …). Pure functions on a `db` object | Yes |
| `src/utils.js` | `AppError`, validation helper, Manila time, audit log, ID numbers | Yes |
| `src/config.js` | `TIMEZONE` (Asia/Manila) | Rarely |
| `seed/seed-data.json` | **FAKE** test data for a TEST Sheet | Yes (or regenerate from the xlsx) |
| `tests/` | Unit tests (`npm test`) + `helpers/db.js` small fake db | Yes |
| `apps-script/Server.gs` | Calls `RFID.runAction`, reads/writes the Sheet, editor-only jobs (`setupSheets`, `createBootstrapAdmin`, `migrateUsersToPasswordLogin`, `benchmarkPasswordHash`, `checkSetup`) | Yes |
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

### 3. Script Properties (secrets)

**Project Settings → Script properties → Add script property.** Values live only
here — never in the repo, the Sheet, or chat.

| Property | Needed for | Notes |
|---|---|---|
| `PASSWORD_PEPPER` | every login and password change | Long random text (40+ characters). **Never change it later**: every password would stop working. |
| `TEST_SEED_PASSWORD` | `setupSheets()` on a **TEST** Sheet only | Password of the FAKE seeded users (must change at first sign-in). Never used for real people. |
| `BOOTSTRAP_ADMIN_USERNAME` | `createBootstrapAdmin()` only | e.g. `cpe.admin` |
| `BOOTSTRAP_ADMIN_PASSWORD` | `createBootstrapAdmin()` only | **Delete it right after** the first admin exists. |
| `SPREADSHEET_ID` | only if the script is not attached to the Sheet | |

`GOOGLE_CLIENT_ID`, `ALLOW_TEST_LOGIN`, `DEFAULT_STUDENT_PASSWORD`, `DEFAULT_INSTRUCTOR_PASSWORD`
and `DEFAULT_ADMIN_PASSWORD` are no longer used — safe to delete (`checkSetup` warns about them).
New and reset accounts get a random temporary password instead (see **Temporary passwords** below).
If a needed property is missing, the action fails with `NOT_CONFIGURED` and nothing is saved.

### 4. Create the tabs (TEST Sheet) — or migrate an existing Sheet

**New TEST Sheet:** function dropdown → **`setupSheets`** → **Run**.
The first time, Google asks for permission → **Review permissions** → project account →
*"Google hasn't verified this app"* → **Advanced → Go to (project name)** → **Allow**.

`setupSheets()` creates missing tabs and fills **only empty tabs** with the FAKE
seed data. The fake seeded users all get `TEST_SEED_PASSWORD` (hashed) and must change
it at first sign-in (if the property is missing, `setupSheets` stops before creating anything): students sign in with their student number (e.g. `9999000001`),
instructors with `instructor01.test` …, the admin with `admin.test`.
**TEST spreadsheet only** — on a real one, empty tabs would be filled with fake people.

**Existing Sheet from the Google Sign-In version:**
1. **File → Make a copy** of the spreadsheet first (backup).
2. Set `PASSWORD_PEPPER`.
3. Run **`migrateUsersToPasswordLogin`**. It adds the new Users columns, gives every
   user a username (students: student number; instructors/admins: the part of the email
   before `@`, lowercase, `2`/`3`… added if taken), signs out old sessions, removes
   `google_sub`, and updates Settings (`max_login_attempts`=5, `lockout_minutes`=15,
   `temp_password_days`=7, removes `allowed_email_rule`). Users **without a password get
   none** (no shared default): the log warns, and an admin must reset each one.
   The log lists every change. Running it again reports "Nothing to change".
4. Check the log for `PROBLEM` lines (a student without a usable student number) and fix them by hand.

**No admin yet?** Set `BOOTSTRAP_ADMIN_USERNAME` + `BOOTSTRAP_ADMIN_PASSWORD`, run
**`createBootstrapAdmin`** (it refuses if an active admin exists), then **delete
`BOOTSTRAP_ADMIN_PASSWORD`**.

Run **`checkSetup`** any time: records per tab, which properties are set (never their values),
and warnings for leftovers.

**Password hashing speed:** `PASSWORD_HASH_ITERATIONS` is **300**: `benchmarkPasswordHash`
measured 1.197 ms per iteration on the real project, so one hash takes about 360 ms.
Run **`benchmarkPasswordHash`** again if that changes, aim for 200–500 ms, then change the
constant in `src/auth/passwords.js`, rebuild, redeploy. Every hash stores its own count,
so old hashes keep working. A *higher* constant re-hashes users at their next sign-in;
a *lower* one does not — hashes made with the earlier 1500 still verify (about 1.6 s per
sign-in) until that user changes their password or an admin resets it.

**Rules for editing the Sheet by hand**
- Row 1 is the column names. Do not rename, reorder or delete them.
- All cells are plain text. Type dates as `2026-10-26` and times as `07:30` (24-hour).
- Prefer the website for changes: it checks for mistakes and writes the audit log. The Sheet does not.

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

## Temporary passwords (how admins hand them out)

- `admin.createStudent` / `createInstructor` / `createAdmin` and `admin.resetPassword` make a
  random 10-character password like `k7Pmx-92Qwa` (no `0 O o 1 l I`). The dash is only for reading: it is
  stored without it, and while the account is on a temporary password, sign-in ignores
  `-` and spaces. Passwords the user chooses are compared exactly.
- The response `data.temp_password` is the **only** place it ever appears. Only its hash is
  stored; it is never written to the Sheet, the AuditLog, or a log. The website shows it once
  in a box with a **Copy** button.
- Give it to the person directly (in person, or a private message to them only). They sign in
  with it and must choose their own password. It expires after 7 days
  (`Users.temp_password_expires_at`, setting `temp_password_days`).
- Lost or expired? Reset the password again; the old temporary password stops working.
- Existing password hashes are unaffected (no migration needed).

## Sign-in (auth API)

Accounts are created only by admins. Username: instructors/admins choose one
(3–32 of `a-z 0-9 . _ -`), students use their 10-digit student number. Usernames are
trimmed, lowercased and unique across all users. New and reset accounts get a random
temporary password and must change it.

| Action | Who | Request | Response `data` |
|---|---|---|---|
| `auth.login` | anyone | `username`, `password` | `session_token`, `user_id`, `username`, `role`, `display_name`, `email`, `must_change_password`, `expires_at` |
| `auth.me` | signed in | — | `user_id`, `username`, `role`, `display_name`, `email`, `must_change_password`, `last_login_at`, `expires_at` |
| `auth.changePassword` | signed in | `old_password`, `new_password` | `must_change_password:false`, `other_sessions_revoked` |
| `auth.logout` | anyone | (`session_token`) | `{}` |
| `admin.resetPassword` | admin | `user_id` (not yourself) | `user_id`, `must_change_password:true`, `sessions_revoked`, `temp_password`, `temp_password_expires_at` |
| `admin.unlockUser` | admin | `user_id` | `user_id` (`NO_CHANGE` if not locked) |

Rules:
- Wrong username and wrong password give the same `INVALID_CREDENTIALS` error.
- `max_login_attempts` (5) failures in a row → `ACCOUNT_LOCKED` for `lockout_minutes` (15).
  While locked the password is not even checked. Success resets the counter.
- `ACCOUNT_DISABLED` is shown only when the password was right.
- While `must_change_password` is TRUE, every action except `auth.me`, `auth.changePassword`,
  `auth.logout` fails with `PASSWORD_CHANGE_REQUIRED`.
- A temporary password older than `temp_password_days` (7) → `TEMP_PASSWORD_EXPIRED`
  ("Ask the admin to reset your password"). Checked only after the password is right.
- New password: 8–128 characters, letters and numbers, not the current one.
  Setting it clears `temp_password_expires_at`.
  Changing it signs out your other sessions.
- The last active admin cannot be deactivated; no action changes a user's role.
- AuditLog: `LOGIN_SUCCESS`, `LOGIN_FAILED`, `ACCOUNT_LOCKED`, `PASSWORD_CHANGED`,
  `PASSWORD_RESET`, `USER_UNLOCKED`, `BOOTSTRAP_ADMIN` — never a password or hash.

**Password storage** (`Users.password_hash`): `v1$<iterations>$<salt>$<hash>` — per-user random
salt, the `PASSWORD_PEPPER`, iterated SHA-256, constant-time comparison.

## How it works (short version)

- **Every request** goes through `runAction()` (`src/actions.js`). Except `auth.login`/`auth.logout`,
  it carries a session token. The server finds it (stored as a SHA-256 hash in `AuthSessions`),
  checks it has not expired or been signed out, that the user is active, has the role the
  action needs, and has no pending forced password change.
- **Ownership:** instructor and student actions take the person's ID from the session
  (`Users.linked_id`), never from the request, and only return their own classes and records.
- **Writes are locked** with `LockService`, so two saves at the same moment cannot overwrite each other.
- **Nothing is half-saved.** If an action throws an `AppError`, no tab is changed and the
  website gets `{ ok:false, error:{ code, message, fields } }`. Only exception: a failed
  sign-in still saves the failure counter, lock and audit row (`error.commit`).
- **Absent is not stored.** It is computed: enrolled students minus those with a Present/Late row.

## Limits to keep in mind

- **Speed:** each request reads the Sheet (~1–3 s per page). Cache rarely-changing tabs if it gets slow.
- **Size:** max 10 million cells per spreadsheet. `Attendance`, `ScanLog`, `AuditLog` grow daily — archive per term.
- **Quotas:** Apps Script has daily runtime/request limits. Check them during a stress test.
- **Attendance corrections** to Absent currently delete the Attendance row (old value kept in
  `AuditLog`). Changing this to a `voided` flag is planned (audit ISS-07).

## Not done yet

- Admin buttons for reset password / unlock, and an account Settings page (Step 3).
- RFID device endpoint (`device.submitScans`, `device.heartbeat`, `device.getRoster` in
  `docs/Device_API_Spec.md`) and the session engine (which class is in this room now, present vs late).
