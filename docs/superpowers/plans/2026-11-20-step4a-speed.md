# Step 4a Speed Prep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each request loads only the tabs its action needs and saves its changes in one all-or-nothing Sheets call.

**Architecture:** Tab declarations live next to each action in `actions.js` (`tabsFor`, `guardDb`). `Server.gs` reads the declared tabs with one `values.batchGet` (append tabs: header + last row only) and saves with one `spreadsheets.batchUpdate`. The fake Apps Script used by `server-gs.test.js` gains a Sheets API fake with counters.

**Tech Stack:** Apps Script V8 + Sheets advanced service v4; Node `node:test`; no dependencies.

**Spec:** `docs/superpowers/specs/2026-11-20-step4a-speed-design.md`

## Global Constraints

- Bundle.gs stays ES2020; run `node tools/build_apps_script.mjs` after `backend/src` edits.
- No fake success; role/ownership checks, LockService on writes, hashed tokens unchanged.
- All cells plain text (`stringValue`); never log or return passwords/hashes.
- Do not deploy.

## Review Focus

1. A write action that changes a tab it did not declare → must throw (nothing saved), never save half / lose silently. Test in Task 3.
2. AuditLog whose last row id is blank or `junk` → full scan, next id = highest+1, no duplicate. Test in Task 4.
3. A tab that shrinks (AuthSessions cleanup on login) → old tail rows blanked, no stale duplicates. Test in Task 5.
4. The batchUpdate call fails → no tab changed, reply `SERVER_ERROR`. Test in Task 5.
5. Failed login (`error.commit`) still saves counter + audit row under the new save path. Existing server-gs test, kept.

---

### Task 1: .gitattributes + Apps Script fake with Sheets API and counters

**Files:** Create `.gitattributes`, `backend/tests/helpers/fake-apps-script.js`; Modify `backend/tests/server-gs.test.js`

- [ ] `.gitattributes`: `*.gs *.js *.mjs *.json text eol=lf`; refresh working copies; `git status` clean after a build.
- [ ] Move `fakeSheet`/`makeServer` into the helper; export `makeServer(props, { sheetsApi = true })`. Add `Sheets.Spreadsheets.Values.batchGet`, `Sheets.Spreadsheets.get` (sheetId, title, gridProperties), `Sheets.Spreadsheets.batchUpdate` (`updateCells`, `appendCells`, `appendDimension`; validates every request against the grid FIRST, applies none on error; `failNext` switch). Counters: `stats = { tabsRead: [], rowsRead, rowsWritten, batchUpdates }`, `resetStats()`.
- [ ] Record the BEFORE numbers (old Server.gs) for the 5 report actions with a scratch script.
- [ ] All existing tests pass.

### Task 2: Correction reason in Attendance + backfillOverrideReasons

**Files:** Modify `backend/src/handlers/portal.js`; Create `backend/src/maintenance.js`; Modify `tools/build_apps_script.mjs` (entry + export), `backend/apps-script/Server.gs`; Test `backend/tests/maintenance.test.js`, `portal.test.js`

- [ ] Tests: manual correction row has `override_reason === reason`; getSession/getHistory give the same `corrected`/`correction_reason` with `db.AuditLog` deleted; `backfillOverrideReasons(db)` fills blank `override_reason` from the LAST `ATTENDANCE_CORRECT` audit row for `session:student`, returns lines, second run changes nothing; non-blank reasons untouched.
- [ ] `correctionsFor`/`historyRows` read Attendance rows: corrected = `override_reason !== ''`; reason = `override_reason`.
- [ ] `backfillOverrideReasons(db) -> string[]` in `maintenance.js`; Server.gs `backfillOverrideReasons()` via `runEditorJob_`.

### Task 3: Tab declarations + guard

**Files:** Modify `backend/src/actions.js`; Test `backend/tests/tabs.test.js`

- [ ] Derive each action's tabs with a throwaway tracer over the existing suite (not committed).
- [ ] Add `reads`/`writes`/`appends` (space-separated strings) to every ACTIONS entry. Export `AUTH_TABS = ['AuthSessions','Users']`, `tabsFor(name) -> { read, write, append } | null`, `guardDb(db, spec, onMissing) -> Proxy`.
- [ ] `tabs.test.js`: unknown action → `null`; every action runs through `runAction` on `guardDb(subset, spec, throw)` with a representative valid request and touches only declared tabs; a write to an undeclared tab throws; a READ action cannot change anything.

### Task 4: Server.gs loads only declared tabs

**Files:** Modify `backend/apps-script/Server.gs`; Test `server-gs.test.js`

- [ ] Tests (via fake counters): `auth.me` reads exactly AuthSessions+Users; `student.getHistory` never reads AuditLog; write actions read AuditLog as 2 rows (header+last); unknown action reads nothing; undeclared tab → loaded + warning logged; malformed last AuditLog id → full scan, no duplicate id.
- [ ] `loadDb_(spec, isWrite)`: null spec = all tabs (editor jobs). Tail tabs via `getLastRow()` + ranges `1:1` and `N:N` in the same batchGet.

### Task 5: Server.gs saves in one batchUpdate

**Files:** Modify `backend/apps-script/Server.gs`; Test `server-gs.test.js`

- [ ] Tests: login appends 1 AuditLog row and leaves old rows untouched; a shrinking tab blanks its old tail; past-grid append grows the grid in the same batch; `failNext` → `SERVER_ERROR` and every tab unchanged; each write request = exactly 1 batchUpdate.
- [ ] `saveDb_(db, state)` builds requests: header `updateCells` when new/grown; append → `appendCells`; else rewrite `updateCells` from row 2 padded with blank rows to the old length; `appendDimension` ROWS/COLUMNS first when needed.

### Task 6: listScheduleClashes

**Files:** Modify `backend/src/maintenance.js`, `backend/src/handlers/classes.js` (export `overlaps`), `Server.gs`; Test `maintenance.test.js`

- [ ] Tests: two active same-term classes overlapping MON in one room → one line naming both + room; inactive class/schedule or other term → none; shared instructor/section reported; db unchanged.
- [ ] `findScheduleClashes(db) -> string[]`; Server.gs `listScheduleClashes()` loads Classes, Schedules, Rooms, Instructors, Sections, logs, no lock, no save.

### Task 7: Report + docs + verification

- [ ] AFTER numbers for the 5 actions; update CLAUDE.md (new editor jobs, tab declarations rule) and BACKEND_VERIFICATION R-notes.
- [ ] `node --test`, build, `node --check` on changed files; commit.
