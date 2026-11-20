# Step 4a — Speed prep (design)

Approved 2026-11-20. No device features in this step.

## Why

Every request reads all ~19 tabs; every write copies every row of every tab
to diff later and needs the whole AuditLog for the next `AUD-` id. An RFID tap
(Step 4) must answer well under 3 s in Apps Script, with taps arriving close
together.

## Decisions

1. **Each action declares its tabs** in `backend/src/actions.js`:
   `reads` (loaded fully), `writes` (subset that may change), `appends`
   (append-only: only the header and LAST row are loaded; new rows are
   appended). Signed-in actions automatically also read `AuthSessions` and
   `Users`. Unknown action = load nothing.
2. **Undeclared tab:** tests fail (strict guard). Live site loads it anyway
   (one extra read) and logs a warning — slower, never broken.
3. **Guard:** rows of read-only and append tabs are frozen; the arrays of
   read-only tabs are frozen too. An undeclared change throws (nothing saved)
   instead of being silently lost.
4. **Next id from the last row:** if the last row's id is blank or malformed
   (not `PREFIX-digits`), load the whole tab and use the full scan.
   Known limit: someone sorting the raw tab by hand breaks "last row = highest".
5. **Correction reason** lives in `Attendance.override_reason` for corrected
   device rows AND new manual rows. `instructor.getSession` and
   `student.getHistory` no longer read AuditLog. Editor-only, idempotent
   `backfillOverrideReasons()` copies reasons from AuditLog into blank
   `override_reason` cells of existing rows.
6. **Safe writes:** all changes of one request go into ONE
   `Sheets.Spreadsheets.batchUpdate` call (`updateCells`, `appendCells`,
   `appendDimension`). No more "clear, then write" (a crash between left an
   empty tab). Shrinking tabs get blank rows written over the old tail.
   LockService stays.
7. **Row limit:** `appendDimension` in the same batch makes room before rows
   go past the grid. Real Apps Script behavior: **UNVERIFIED** (task 4f).
8. **Editor-only `listScheduleClashes()`**: logs ACTIVE classes (same term)
   whose ACTIVE schedules overlap on the same day and share a room,
   instructor or section. Read-only.
9. **`.gitattributes`**: `.gs/.js/.mjs/.json` are LF.

## What Google guarantees for spreadsheets.batchUpdate (docs, 2026-11-20)

- "If any request is not valid then the entire request will fail and nothing
  will be applied." / "the updates in the request will be applied together
  atomically". Requests are applied in order.
- NOT guaranteed: with collaborators editing at the same time, "your changes
  may be altered with respect to collaborator changes".
- Not documented: a call that times out or loses its response may still have
  been applied — the script then reports an error although the data was saved.
  Apps Script's own quotas/timeouts are separate from the API.

## Approaches considered

- Strict guard everywhere (throw on undeclared tab) — rejected: one missed
  declaration breaks a live feature.
- `values.batchUpdate` — rejected: request-based `spreadsheets.batchUpdate`
  is the one documented as all-or-nothing.
- Keep AuditLog as the source of correction reasons — rejected: the
  fastest-growing tab would stay on two portal reads.
