# Date Filters for Attendance History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optional `{ from, to }` (YYYY-MM-DD, Manila, inclusive) on every instructor/student history action, validated by one shared helper.

**Architecture:** One helper `dateRange(request)` in `backend/src/utils.js` validates and returns `{ from, to, has(date) }`. `portal.js` filters session rows with `range.has(row.session_date)` before any counting, so totals and rates are computed only inside the range. No new tabs, so `actions.js` does not change.

**Tech Stack:** Node ES modules, `node:test`, Apps Script bundle (ES2020).

**Spec:** user request (2026-11-20) + `docs/PROJECT_CONTEXT.md` section 8 ("Filter attendance by date", "Filter their records by date").

## What exists today (backend/src/handlers/portal.js)

| Action | Date range today? |
|---|---|
| `instructor.getDashboard` | single `date` (one day), not a range — unchanged |
| `instructor.getClassReport` | **yes** `from`/`to`, but bad format → `BAD_REQUEST` (not `VALIDATION_ERROR`), no 366-day limit |
| `instructor.listSessions` | no |
| `instructor.getStudentHistory` | no |
| `instructor.getClassRoster` | no — **added** (approved change 1) |
| `instructor.getSession` | one session — n/a |
| `student.getOverview` | no (totals, per-subject numbers, `recent` all come from history) |
| `student.getHistory` | no |

Note: "no range" today means *all sessions of the active classes*, not a term-date filter. No range keeps exactly that.

## Global Constraints

- `from`, `to` optional; missing or `''` = no bound. Both absent = old output (plus a `range` echo).
- Valid = `YYYY-MM-DD` and a real calendar date (`isValidDate`).
- `from > to` → `VALIDATION_ERROR` field `to` (frontend already shows `fields.to`).
- Span (only when both given): inclusive day count ≤ 366 (e.g. 2026-01-01..2027-01-01 OK, ..2027-01-02 rejected) → field `to`.
- Bad format → `VALIDATION_ERROR` field `from` or `to` (both fields if both bad).
- Validation runs after the ownership check, so a forbidden class still answers `FORBIDDEN`.
- "today" = `ctx.now()`; it only feeds the existing not_scanned/absent rule — no extra "future date" rule.

## Review Focus

1. `from === to` (single day) → that day's sessions only.
2. Range with no sessions → empty lists, `rate: null`, no crash.
3. Open session inside range before its end → still `not_scanned`, not counted.
4. Only `from` or only `to` given → open-ended bound.
5. Student passing another student's `student_id` plus a range → still own records only.

---

### Task 1: `dateRange` helper

**Files:** Modify `backend/src/utils.js`; Test: `backend/tests/date-filters.test.js` (new)

**Produces:** `dateRange({ from = '', to = '' }) -> { from, to, has(date: string): boolean }`; throws `validationError(fields)`.

- [ ] Write failing tests: no range → `has('1999-01-01')` true; `2026-02-30` / `2026-1-5` → `fields.from`; `from > to` → `fields.to`; 366 days OK, 367 rejected; boundaries `has(from)` and `has(to)` true, day before/after false.
- [ ] Run `node --test backend/tests/date-filters.test.js` → FAIL (not exported).
- [ ] Implement (span via `Date.UTC` difference / 86400000 + 1 ≤ 366).
- [ ] Run → PASS.

### Task 2: Wire the range into portal.js

**Files:** Modify `backend/src/handlers/portal.js`; Test: `backend/tests/date-filters.test.js`

**Consumes:** `dateRange` from Task 1.

- `historyRows(db, maps, studentId, classes, now, range)` filters `range.has(row.session_date)` → covers `student.getHistory`, `student.getOverview` (totals, subjects, `last`, `recent`), `instructor.getStudentHistory`.
- `instructorListSessions`: filter ClassSessions by range (all statuses, as today).
- `instructorClassRoster`: filter counted sessions by range (totals + `sessions_held`).
- `instructorClassReport`: replace its own checks with `dateRange`; counted + cancelled sessions filtered with `range.has`.
- Each of these returns `range: { from, to }`.

Test fixture: add a second CLS-0001 session `SES-0003` on `2026-11-09` (STU-0001 absent, no record) so ranges change numbers.

- [ ] Failing tests per action: range `2026-11-16..2026-11-16` keeps SES-0001 only; `2026-11-09..2026-11-15` keeps SES-0003 only; STU-0001 rate 1 in first, 0 in second, 0.5 with no range (= old behavior); listSessions/report session ids; report cancelled count inside range; overview totals inside range; open session inside range during class → `not_scanned`; student with `student_id: 'STU-0004'` + range → own records only; bad `from` on each action → `VALIDATION_ERROR`; existing `portal.test.js` unchanged and green.
- [ ] Run → FAIL.
- [ ] Implement.
- [ ] Run `node --test` → all PASS.

### Task 3: Verify and commit

- [ ] `node --test`, `node tools/build_apps_script.mjs`, `node --check` on `utils.js`, `portal.js`, test file → show output.
- [ ] Short note in `docs/` API doc that lists these actions (if one lists their params).
- [ ] Commit on branch `date-filters` (`feat(portal): from/to date filters on history actions`). No deploy.
