# Step 4c Session Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pure scan → session decision engine, plus BUG-7 (no "absent" before a session ends).

**Architecture:** New `backend/src/sessions.js` (pure). Portal and dashboard handlers take
"now" from `ctx.now()` and use `missingStatus` / `sessionPhase`.

**Tech Stack:** Node ES modules, node:test, Apps Script bundle via tools/build_apps_script.mjs.

**Spec:** docs/superpowers/specs/2026-11-20-step4c-session-engine-design.md

## Global Constraints
- Keep `'not_scanned'`; no frontend change. Bundle stays ES2020. No Sheet writes.
- Every test uses a fake clock; none depends on the real date.

## Review Focus
- Tap at 23:59 Sunday vs 00:00 Monday → different session_date and day.
- `scanned_at` as string number / NaN → INVALID_TIME, not a crash.
- Second tap after newSession was inserted → same session, no second newSession.
- Session explicitly `closed` early → absent even if the scheduled end is later.
- Admin dashboard and instructor counts agree on absent/not_scanned.

---

### Task 1: utils.manilaAt + sessions.js (engine)

**Files:** Create `backend/src/sessions.js`, `backend/tests/sessions.test.js`; modify
`backend/src/utils.js`, `tools/build_apps_script.mjs` (ENTRIES += `sessions.js`).

**Produces:** `manilaAt(ms) -> {date,time,iso}`; `sessionPhase(session, now)`;
`missingStatus(session, now)`; `resolveScan(db, scan, settings, nowMs)`.

- [ ] Write tests (fake clock, Asia/Manila; Monday 2026-11-16, class 08:00–10:00 in RM-0001):
  07:45 accepted; 07:44 NO_ACTIVE_SESSION; 10:00 accepted; 10:01 NO_ACTIVE_SESSION;
  back-to-back (10:00–12:00 class, tap 09:50) picks enrolled class; enrolled in both →
  one without a record; wrong day; inactive class / schedule / term ignored; date outside
  term; cancelled session; manual session wins; 23:59 vs 00:00 date; second tap reuses
  session; DUPLICATE; NOT_ENROLLED; future (> 5 min) / 0 / missing → INVALID_TIME;
  sessionPhase upcoming / in_progress / ended / cancelled; missingStatus.
- [ ] Run `node --test backend/tests/sessions.test.js` → FAIL (module missing).
- [ ] Implement per spec Decisions.
- [ ] Run → PASS.

### Task 2: BUG-7 + one clock in portal and dashboard

**Files:** `backend/src/handlers/portal.js`, `backend/src/handlers/dashboard.js`,
`backend/tests/helpers/db.js` (`clockAt(iso)`, `CTX`), `portal.test.js`,
`verification.test.js`, `attendance-override.test.js`.

- [ ] Add `clockAt(iso) -> { now: () => Date.parse(iso) }` and `CTX = clockAt('2026-11-20T12:00:00+08:00')`;
  pass `CTX` as the 4th arg in every portal/dashboard call in tests.
- [ ] Turn BUG-7 todo into a passing test: clock 2026-11-16 09:00 (in progress) →
  `session.absent === 0`, `not_scanned === 1`; clock 10:01 → absent 1. Same for
  roster/report/student overview totals and admin dashboard counts.
- [ ] Run → FAIL. Replace every `manilaNow()` in portal.js / dashboard.js with
  `manilaAt(ctx.now())`, thread `now` into `statusOf`, `sessionCounts`, `describeSession`,
  `classSummary`, dashboard `describe`. Run → PASS.

### Task 3: Verify and commit
- [ ] `node --test`, `node tools/build_apps_script.mjs`, `node --check` on changed files.
- [ ] Update BACKEND_VERIFICATION BUG-7 row to FIXED; CLAUDE.md layout line for sessions.js.
- [ ] Commit on `step4c-session-engine`.
