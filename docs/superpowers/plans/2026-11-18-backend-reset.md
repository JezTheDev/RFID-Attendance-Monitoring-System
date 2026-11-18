# Backend Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move shared handlers to `backend/src`, remove demo mode, add Node unit tests, fix docs.

**Architecture:** Handlers stay ES modules (pure functions on a `db` object); the build script wraps them into `Bundle.gs` for Apps Script. Tests import the same modules directly in Node.

**Tech Stack:** Node 24 built-in `node:test` + `node:assert`, Google Apps Script (V8), vanilla ES modules, Python (xlsx tool only).

**Spec:** `docs/superpowers/specs/2026-11-18-backend-reset-design.md`

## Global Constraints
- No npm dependencies. `package.json` has only `type` and `scripts.test`.
- No handler logic changes (only import paths and `DemoError` → `AppError`).
- Bundle.gs must contain no syntax newer than ES2020 (build script guard).
- Do not change login behavior beyond removing demo mode.
- Work on branch `backend-reset`; one commit per part.

## Review Focus
- Server.gs still finds `RFID.ACTIONS`, `RFID.WRITE`, `RFID.setting`, `RFID.manilaNow`, `SEED_DATA` → verified by grep after build.
- `manilaNow()` in Node (no `Utilities`) still returns `+08:00` → covered by utils test.
- Frontend pages must not import anything under `demo/` → grep check.
- Errors thrown by handlers still have string `code` (Server.gs relies on it) → every rejection test asserts `code`.
- `node --check` on every JS file still passes with `"type":"module"` at the root.

---

### Task 1: CLAUDE.md
- [ ] Create `CLAUDE.md` (summary, layout, build/deploy, tests, rules, decisions). Commit `docs: add CLAUDE.md`.

### Task 2: Restructure + remove demo mode
**Files:** move `frontend/assets/js/demo/{actions.js,demo-utils.js,handlers/*}` → `backend/src/{actions.js,utils.js,handlers/*}`; create `backend/src/config.js`, `backend/seed/seed-data.json`; rename tool to `tools/xlsx_to_seed_data.py`; modify `tools/build_apps_script.mjs`, `frontend/assets/js/{api.js,config.js,ui.js,auth.js,pages/login.js,auth-forms.js}`, `frontend/index.html`, `backend/apps-script/Server.gs` (comments); delete `demo-api.js`, `demo-store.js`, `demo-data.js`.
**Interfaces produced:** `backend/src/utils.js` exports `AppError(code, message, fields)`, `validationError(fields)`, plus all former demo-utils exports unchanged. `backend/src/config.js` exports `TIMEZONE`.
- [ ] `git mv` files; sed `DemoError`→`AppError`, `../demo-utils.js`→`../utils.js`; utils imports `{ TIMEZONE } from './config.js'`.
- [ ] Export demo-data to JSON via node one-liner.
- [ ] Update build (ENTRIES `actions.js`, `utils.js`; root `backend/src`; seed from JSON; `Object.assign({}, __m['config'], __m['utils'], __m['actions'])`).
- [ ] Run `node tools/build_apps_script.mjs`; expect "Wrote ... Bundle.gs (… modules …)".
- [ ] Remove demo paths in frontend. grep for `demo-api|demo-store|demo-data|demoSignIn|MODE` → none.
- [ ] Commit `refactor: move handlers to backend/src, remove demo mode`.

### Task 3: Tests
**Files:** create `package.json`, `backend/test/helpers/db.js` (`makeDb(overrides)` returns all tables, `adminSession`, `sessionFor(userId, role)`), `backend/test/{portal,classes,students,utils}.test.js`.
- [ ] Tests (each asserts thrown `code`):
  - student: `studentHistory` with another class → `FORBIDDEN`; `studentOverview` only own records.
  - instructor: `instructorGetSession` / `instructorCorrectAttendance` on another instructor's session → `FORBIDDEN`; `instructorClassRoster` other class → `FORBIDDEN`.
  - schedule: room / instructor / section overlap → `VALIDATION_ERROR` with `fields.start_time`; touching slots (10:00–11:00 then 11:00–12:00) accepted.
  - enrollment: enrolling twice → `added: 0` and one row; re-enroll after drop reuses the row.
  - cards: bad UID, UID active on other student, UID previously owned by another, replace without reason, replace with reason → old `lost`; revoke with no card → `NO_ACTIVE_CARD`; revoke short reason; revoke bumps `roster_version`.
  - absent count: 3 enrolled, 1 present, 1 late → `absent: 1`; dropped student's record not counted.
- [ ] Run `npm test` / `node --test`; expect all pass. Mutation-check one ownership guard to prove the test can fail.
- [ ] Commit `test: add node unit tests for handlers`.

### Task 4: Docs
- [ ] Rewrite `README.md`, `backend/README.md`, `frontend/README.md` to match. Commit `docs: update READMEs`.

### Final verification
`node --test`; `node tools/build_apps_script.mjs`; `node --check` on all JS; grep for removed names.
