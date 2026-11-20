# Login Backend (Step 2) — Design

Status: design approved by the project owner in the task brief (2026-11-18).
Items marked **[call]** are gaps the brief left open, decided by the builder;
they are listed in the final report for review.

## Intent

Replace Google Sign-In and the test sign-in with admin-created username +
password accounts, so the deployed site has a real, safe login. Backend, data,
tests, and the smallest frontend change that keeps the site usable.

## Goals

- `auth.login`, `auth.me`, `auth.changePassword`, `auth.logout`,
  `admin.resetPassword`, `admin.unlockUser`.
- Salted, peppered, iterated SHA-256 hashes, `v1$<iter>$<salt>$<hash>`.
- Lockout (5 failures → 15 min), forced first-login password change.
- Bootstrap admin + idempotent migration of the existing Sheet.
- Remove every Google Sign-In / test sign-in path.

## Non-goals

Login page polish, Settings/account page, admin reset/unlock buttons (Step 3).
Device API. Self-service "forgot password".

## Anti-goals

- Any fake success, any plaintext password or hash in a response or log.
- Account guessing through different errors for wrong username vs wrong password.
- Handler logic rewrites beyond what the new fields need.

## Approaches considered

1. **Auth logic in `backend/src` (chosen).** Login, sessions, authorization,
   must-change gate, migration, bootstrap are pure functions on `db` plus a
   small `ctx` (crypto adapter, Script Properties reader, clock). Server.gs
   keeps only Sheet I/O, LockService, and the Apps Script crypto/properties
   wiring. Everything the brief asks to test is testable in Node.
2. Auth logic stays in Server.gs (as today). Smaller diff, but the required
   tests (lockout with fake clock, must-change gate, session revocation)
   cannot run in Node. Rejected.
3. Hybrid: hashing in src, sessions in Server.gs. Splits one flow over two
   places and still leaves the gate untested. Rejected.

## Design

### Context object (`ctx`)

Built once per request by Server.gs (`RFID.createAuthContext`) and by tests:

- `crypto`: `{ sha256(bytes) -> bytes, utf8(text) -> bytes, randomHex(nBytes) }`.
  Apps Script adapter uses `Utilities.computeDigest` / `Utilities.newBlob` /
  `Utilities.getUuid`; Node adapter uses `node:crypto`. Bytes may be signed
  (Apps Script) or unsigned (Node); the shared code masks with `& 0xff`.
- `getProperty(name)`: Script Properties.
- `now()`: epoch ms (fake clock in tests).
- `iterations` (optional override, tests only).

### Password hash

`secret = utf8(PEPPER + "\u0000" + password)`, `h0 = sha256(utf8(salt) ++ secret)`,
`h(i) = sha256(h(i-1) ++ secret)`, stored `v1$<iterations>$<saltHex32>$<hashHex64>`.
Verification re-computes with the stored iteration count and compares hex in
constant time (XOR over the full length). `PASSWORD_HASH_ITERATIONS` is a
constant in `backend/src/auth/passwords.js`. On a successful login, a hash
with fewer iterations than the constant is re-hashed (so raising it later
upgrades users silently). Unknown usernames still run one dummy hash so the
response time does not reveal whether the account exists.

Missing `PASSWORD_PEPPER` → `NOT_CONFIGURED`.

### Users and Settings columns

Users: `user_id, username, email, role, linked_id, account_status,
password_hash, must_change_password, failed_attempts, locked_until,
password_changed_at, created_by, last_login_at, created_at, updated_at,
display_name`. `google_sub` removed. Settings: `allowed_email_rule` removed;
`max_login_attempts=5`, `lockout_minutes=15` added.

### Usernames

Trimmed, lowercased, unique across all Users. Students: username = student
number (10 digits), kept in sync on `updateStudent`. Instructors/admins:
`^[a-z0-9._-]{3,32}$` **[call]**. Email becomes optional everywhere (validated
and unique only when given) **[call: uniqueness kept]**.

### Default passwords

`DEFAULT_STUDENT_PASSWORD`, `DEFAULT_INSTRUCTOR_PASSWORD`, and
**`DEFAULT_ADMIN_PASSWORD` [call]** (the brief says "one default per role" and
asks admin create to set a default, but names only two properties). Missing
property → `NOT_CONFIGURED`, nothing saved.

### Actions (all in `backend/src/actions.js`)

| Action | Role | Mode |
|---|---|---|
| `auth.login` | public | write |
| `auth.logout` | public (token optional) | write |
| `auth.me` | any signed-in | read |
| `auth.changePassword` | any signed-in | write |
| `admin.resetPassword` | admin | write |
| `admin.unlockUser` | admin | write |

`runAction(db, request, ctx)` in `backend/src/auth/session.js` looks the
action up, authorizes the token (ported from Server.gs `authorize_`), applies
the must-change gate (only `auth.me`, `auth.changePassword`, `auth.logout`
allowed → `PASSWORD_CHANGE_REQUIRED`), then runs the handler with
`(db, request, session, ctx)`.

### Login rules

1. Look up by normalized username. Unknown → dummy hash, audit
   `LOGIN_FAILED` (no attempted text logged **[call]**: people type passwords
   into the username box), `INVALID_CREDENTIALS` "Incorrect username or password."
2. If `locked_until` is in the future → `ACCOUNT_LOCKED` with minutes left,
   password NOT checked **[call: this reveals the account exists once it is
   locked; the alternative hides lockouts from real users]**.
   An expired lock is cleared and the counter restarts.
3. Wrong password → `failed_attempts+1`, audit `LOGIN_FAILED`; on reaching
   `max_login_attempts` set `locked_until = now + lockout_minutes`, audit
   `ACCOUNT_LOCKED`, return `ACCOUNT_LOCKED`; otherwise `INVALID_CREDENTIALS`.
   These failures must be SAVED: the error carries `commit: true` and Server.gs
   saves before replying (all other errors still save nothing).
4. Correct password but disabled → `ACCOUNT_DISABLED` (only someone with the
   right password learns the account is disabled).
5. Success → reset counter/lock, (re-hash if needed), session row, audit
   `LOGIN_SUCCESS`, return `{ session_token, user_id, username, role,
   display_name, email, must_change_password, expires_at }`.

### Change / reset / unlock

- `auth.changePassword {old_password, new_password}`: old must verify
  (`VALIDATION_ERROR` on `old_password`, not counted toward lockout **[call]**);
  new: 8–128 chars **[call: max]**, ≥1 letter and ≥1 digit, ≠ role default,
  ≠ old. Clears must-change, sets `password_changed_at`, revokes the user's
  other sessions, audit `PASSWORD_CHANGED`.
- `admin.resetPassword {user_id}`: role default, must-change TRUE, clear
  lockout, revoke all their sessions, audit `PASSWORD_RESET`. Not on yourself
  **[call]**.
- `admin.unlockUser {user_id}`: clear counter + lock, audit `USER_UNLOCKED`;
  `NO_CHANGE` if nothing to clear.
- Last active admin cannot be disabled (existing check, kept and tested); no
  action changes a user's role, so "demote" has no entry point.

### Editor-only functions (Server.gs)

- `createBootstrapAdmin()`: `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD`;
  refuses if an active admin exists; password must pass the change rules;
  must-change TRUE.
- `migrateUsersToPasswordLogin()`: adds missing columns; usernames (students
  first = student number; instructors/admins = email local part, sanitized,
  de-duplicated with `2`, `3`…; fallback `user_id`); sets default hashes +
  must-change TRUE only where `password_hash` is empty; clears `google_sub`
  and deletes that empty column; fixes Settings rows; logs every change.
  Running it twice changes nothing the second time.
- `setupSheets()`: after seeding an empty Users tab it runs the same migration
  so seeded users get default-password hashes (seed JSON has no hashes).
- `benchmarkPasswordHash()`: times one hash in Apps Script to tune iterations.

### Removed

`auth.google`, `auth.testSignIn`, `googleSignIn_`, `testSignIn_`,
`GOOGLE_CLIENT_ID`, `ALLOW_TEST_LOGIN`, `google_sub`/`google_linked` in
handlers, `script.external_request` scope (UrlFetchApp no longer used).

### Minimal frontend

`auth.js signIn(username, password)`; login form field becomes
"Username or student number"; real submit; if `must_change_password`, a small
change-password form calls `auth.changePassword`; "Test as…" buttons and
Google button removed. **[call]** Also add a Username field to the admin
Instructor/Admin create forms and make email optional there and on Students —
otherwise those create forms break against the new backend.

## Left to the builder

File split inside `backend/src/auth/`, error message wording, test layout.
