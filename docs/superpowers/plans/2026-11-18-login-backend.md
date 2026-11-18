# Login Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Username + password login (hashing, lockout, forced change, reset/unlock, bootstrap, migration) replacing Google/test sign-in.

**Architecture:** All auth logic lives in `backend/src/auth/` as pure functions on `(db, request, session, ctx)`; `ctx` injects crypto, Script Properties and the clock. Server.gs keeps Sheet I/O, LockService and the Apps Script wiring, and calls `RFID.runAction`.

**Tech Stack:** Node 24 `node:test`, `node:crypto` (tests only), Apps Script V8 (`Utilities`, `PropertiesService`).

**Spec:** `docs/superpowers/specs/2026-11-18-login-backend-design.md`

## Global Constraints

- No npm dependencies. Bundle.gs ES2020 only (build guard). No `.at()`, `??=`, `replaceAll` in `backend/src`.
- Hash format `v1$<iterations>$<saltHex>$<hashHex>`; Script Properties `PASSWORD_PEPPER`, `DEFAULT_STUDENT_PASSWORD`, `DEFAULT_INSTRUCTOR_PASSWORD`, `DEFAULT_ADMIN_PASSWORD`, `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_PASSWORD`.
- Settings `max_login_attempts=5`, `lockout_minutes=15`.
- Never return/log a password or hash. Missing property → `NOT_CONFIGURED`, nothing saved.
- Sheet cells are text: booleans `'TRUE'`/`'FALSE'`, counters `'0'`, timestamps Manila ISO `+08:00`.
- Branch `login-backend`, one commit per task.

## Review Focus

- Username typed with spaces/uppercase (`" 2024000001 "`) → logs in (normalize trim+lowercase). Test in Task 2.
- Lock expired exactly at `locked_until` → next attempt is evaluated normally and counter restarts. Test in Task 2.
- Session of a user whose password was reset/disabled → `NOT_SIGNED_IN` on the next request. Test in Task 3.
- Student number edited by admin → username follows, collision with another user's username rejected. Test in Task 3.
- Migration on a Sheet where two instructors share an email local part → `ana`, `ana2`. Test in Task 4.

---

### Task 1: Password hashing + crypto adapters

**Files:** Create `backend/src/auth/passwords.js`, `backend/src/auth/crypto-apps-script.js`, `backend/tests/helpers/auth.js`, `backend/tests/passwords.test.js`; add `toManilaIso(ms)` to `backend/src/utils.js`.

**Interfaces – Produces:**
- `PASSWORD_HASH_ITERATIONS` (number), `hashPassword(crypto, pepper, password, iterations?) -> string`, `verifyPassword(crypto, pepper, password, stored) -> boolean`, `hashIterations(stored) -> number`, `constantTimeEqual(a, b) -> boolean`, `sha256Hex(crypto, text) -> string`.
- `appsScriptCrypto() -> { sha256(bytes), utf8(text), randomHex(n) }` (uses global `Utilities` lazily).
- tests helper `nodeCrypto`, `makeCtx({ props?, now? })` returning ctx with a settable clock `ctx.clock.ms`.
- `toManilaIso(ms) -> 'YYYY-MM-DDTHH:mm:ss+08:00'`.

- [ ] Tests: format regex `^v1\$\d+\$[0-9a-f]{32}\$[0-9a-f]{64}$`; round-trip true; wrong password false; wrong pepper false; two hashes of same password differ (salt); stored iterations honored; `constantTimeEqual` length mismatch false; Apps Script adapter with a fake signed-byte `Utilities` gives identical hash to the Node adapter for the same salt; `toManilaIso(Date.UTC(2026,0,1,16))` = `2026-01-02T00:00:00+08:00`.
- [ ] Run, see failures; implement; run `node --test backend/tests/passwords.test.js` → pass. Commit `feat(auth): salted peppered iterated password hashing`.

### Task 2: Sessions, login, me, changePassword, logout, runAction gate

**Files:** Create `backend/src/auth/context.js`, `backend/src/auth/session.js`, `backend/src/auth/account.js`; modify `backend/src/actions.js`; tests `backend/tests/auth.test.js`, update `backend/tests/actions.test.js`, `backend/tests/helpers/db.js` (Users get new columns, usernames, Settings rows).

**Interfaces – Produces:**
- `createAuthContext({ crypto, getProperty, now, iterations? }) -> ctx` with `ctx.hash(pw)`, `ctx.verify(pw, stored)`, `ctx.defaultPassword(role)`, `ctx.pepper()`, `ctx.newToken()`, `ctx.tokenHash(token)`, `ctx.now()`.
- `runAction(db, request, ctx) -> data` (throws AppError; `error.commit === true` means Server.gs must save).
- `login`, `logout`, `me`, `changePassword` handlers; `normalizeUsername(text)`; `validateNewPassword(ctx, role, oldPw, newPw)`.
- Action table: `role` ∈ `'public' | 'any' | 'admin' | 'instructor' | 'student'`; exported `PUBLIC`, `ANY`; `PASSWORD_CHANGE_ALLOWED` = `auth.me`, `auth.changePassword`, `auth.logout`.

- [ ] Tests (names = assertions): login success returns role/display_name/must_change_password and a token that authorizes; unknown username and wrong password → identical `{code,message}`; 5 wrong → `ACCOUNT_LOCKED`, correct password still rejected while locked, accepted after `ctx.clock.ms += 15min`; failures carry `commit` and persist `failed_attempts`; disabled user with correct password → `ACCOUNT_DISABLED`; must_change blocks `admin.listStudents` with `PASSWORD_CHANGE_REQUIRED` but allows `auth.me`; changePassword rules (short, no digit, equals default, equals old, wrong old) and success clears flag and revokes other sessions but not current; audit actions logged; no response contains `password_hash`, `v1$`, or the plaintext; login with low-iteration hash upgrades it.
- [ ] Implement; run all tests; commit `feat(auth): password login, sessions and must-change gate`.

### Task 3: Admin account management

**Files:** Create `backend/src/auth/admin-users.js` (`resetPassword`, `unlockUser`, `assertUsernameFree`, `newUserRow`); modify `handlers/students.js`, `handlers/instructors.js`, `handlers/admins.js`, `handlers/portal.js` (drop `google_*`); tests `backend/tests/users.test.js`; update existing tests to pass `ctx`.

**Interfaces – Produces:** `newUserRow(db, ctx, { username, email, role, linked_id, display_name? }, session) -> row`; create handlers take `(db, input, session, ctx)`.

- [ ] Tests: student create → username = student number, hash verifies with default, must_change TRUE; instructor/admin create need username; username unique across roles (case-insensitive); email optional; missing default property → `NOT_CONFIGURED` and db unchanged; resetPassword restores default, sets flag, clears lock, revokes sessions, not on self; unlockUser clears lock / `NO_CHANGE`; cannot disable last active admin; updateStudent changes username; no hash in list/get responses.
- [ ] Implement; tests pass; commit `feat(auth): admin create/reset/unlock with usernames`.

### Task 4: Migration, bootstrap, seed

**Files:** Create `backend/src/auth/migration.js` (`migrateUsersToPasswordLogin(db, ctx) -> string[]`, `createBootstrapAdmin(db, ctx) -> string[]`, `USER_COLUMNS`); modify `backend/seed/seed-data.json`; tests `backend/tests/migration.test.js`.

- [ ] Tests: migration sets usernames (students = number, others = email local part, dedup `ana2`), hashes + must_change, clears `google_sub`, fixes Settings; second run returns "nothing to change" and db deep-equal; seed has no `google_sub`/`password`/hash values and has every `USER_COLUMNS` key; bootstrap refuses with an active admin, creates must-change admin otherwise, rejects weak password.
- [ ] Implement; tests pass; commit `feat(auth): migration, bootstrap admin, seed without google_sub`.

### Task 5: Server.gs + manifest + build

- [ ] Replace router with `RFID.runAction`; save on `error.commit`; remove Google/test sign-in and helpers moved to src; add `createBootstrapAdmin`, `migrateUsersToPasswordLogin`, `benchmarkPasswordHash`, `checkSetup` property report; setupSheets runs migration after seeding Users. Remove `script.external_request` scope.
- [ ] `node tools/build_apps_script.mjs`, `node --check` on Server.gs copy (as .js), grep for removed names. Commit.

### Task 6: Minimal frontend

- [ ] `auth.js signIn`, login form username field + real submit + change-password form, remove test buttons/Google/config flags; admin forms username field + optional email. `node --check` each. Commit.

### Task 7: Docs + verification

- [ ] CLAUDE.md, backend/README.md (auth API, properties, deploy + migration steps), audit report note. Full verification run. Commit.
