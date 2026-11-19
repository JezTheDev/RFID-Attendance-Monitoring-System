// Editor-only maintenance jobs (Server.gs runs them from the Apps Script editor).
// Each takes the db and returns lines to log.
import { CORRECTION_ACTION } from './handlers/portal.js';

// Copies correction reasons from AuditLog into blank Attendance.override_reason
// cells (rows corrected before the reason was stored there). Safe to run again.
export function backfillOverrideReasons(db) {
  const reasons = new Map();
  db.AuditLog
    .filter((row) => row.action === CORRECTION_ACTION && row.reason)
    .forEach((row) => reasons.set(row.entity_id, row.reason)); // later rows win
  let filled = 0;
  db.Attendance.forEach((row) => {
    const reason = reasons.get(`${row.session_id}:${row.student_id}`);
    if (reason && !row.override_reason) {
      row.override_reason = reason;
      filled += 1;
    }
  });
  return filled
    ? [`Filled the correction reason of ${filled} Attendance row(s) from AuditLog.`]
    : ['Nothing to change: every corrected Attendance row already has its reason.'];
}
