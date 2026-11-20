# Temporary Passwords Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared per-role default password with a random, one-time-shown, 7-day temporary password per user.

**Architecture:** `passwords.js` gets a generator fed by the existing crypto adapter (`randomHex`); `ctx.newTempPassword()` exposes it. `admin-users.js` gets `issueTempPassword(db, ctx, user)` used by the three create handlers and `resetPassword`. Login checks `temp_password_expires_at`; changePassword clears it. Seeded fake users get `TEST_SEED_PASSWORD` via a new editor job.

**Tech Stack:** Node ES modules, node:test, Apps Script (V8, ES2020 bundle), Bootstrap 5 frontend.

**Spec:** the task brief in the conversation of 2026-11-19 (design points 1-6, test list). Not copied here.

## Global Constraints

- Temp password: 10 chars from `23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz` (no 0/O/o, 1/l/I), shown and used as `xxxxx-xxxxx`.
- Randomness only from `crypto.randomHex` (Apps Script: `Utilities.getUuid`; Node: `node:crypto`). No `Math.random`.
- Store only the v1 hash; `must_change_password = 'TRUE'`; `temp_password_expires_at = now + temp_password_days` (Setting, default 7).
- Expired → `TEMP_PASSWORD_EXPIRED`, "Ask the admin to reset your password".
- The value appears only in the create/reset response `data.temp_password`; never in AuditLog, logs, or any Sheet cell.
- `DEFAULT_*_PASSWORD` removed from code; `checkSetup` warns "safe to delete".

## Review Focus

- Bias in the generator (byte → alphabet): rejection sampling, test the format over many draws.
- A user who types the temp password without the hyphen: fails (the hyphen is part of the password). Documented in the modal text.
- Hashless users after `migrateUsersToPasswordLogin`: they stay hashless (cannot log in) and are reported, never given a shared password.
- An already-open session whose temp password expires: still allowed to change the password (it proved knowledge). Not tested; by design.
- Old `v1$1500$…` / `v1$300$…` seeded hashes: still verify, with no expiry column at all.

---

### Task 1: Generator + issue/expire/clear (backend)

**Files:** `backend/src/auth/{passwords,context,crypto-apps-script?,admin-users,account,migration}.js`, `handlers/{students,instructors,admins}.js`, tests `backend/tests/temp-passwords.test.js`, update `users.test.js`, `auth.test.js`, `migration.test.js`, `helpers/auth.js`, seed json (+ column, + setting).

**Interfaces – Produces:**
- `generateTempPassword(crypto) -> 'xxxxx-xxxxx'`, `TEMP_PASSWORD_PATTERN` (passwords.js)
- `ctx.newTempPassword()`; `ctx.defaultPassword` removed
- `issueTempPassword(db, ctx, user) -> { temp_password, temp_password_expires_at }` (admin-users.js)
- create responses and `resetPassword` spread that object into their data
- `validateNewPassword(oldPassword, newPassword)` (no ctx/role)
- `seedTestPasswords(db, ctx) -> string[]` (migration.js) — `TEST_SEED_PASSWORD`, NOT_CONFIGURED if missing

- [ ] Write failing tests (spec test list), run → fail
- [ ] Implement, run `npm test` → pass, commit

### Task 2: Server.gs + build

- [ ] `REQUIRED_PROPERTIES = ['PASSWORD_PEPPER']`; setupSheets needs `TEST_SEED_PASSWORD` and runs `RFID.seedTestPasswords`; checkSetup warns on `DEFAULT_*`
- [ ] vm tests: setupSheets error names TEST_SEED_PASSWORD; create over doPost → value absent from every Sheet cell and log
- [ ] build, `npm test`, commit

### Task 3: Frontend + docs

- [ ] One-time modal (`showTempPassword(result)` in ui.js) after student/instructor/admin create; login warning for `TEMP_PASSWORD_EXPIRED`; "default password" copy fixed
- [ ] CLAUDE.md, backend/README.md; `node --check`; commit
