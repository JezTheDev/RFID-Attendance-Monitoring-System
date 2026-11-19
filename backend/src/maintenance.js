// Editor-only maintenance jobs (Server.gs runs them from the Apps Script editor).
// Each takes the db and returns lines to log.
import { CORRECTION_ACTION } from './handlers/portal.js';
import { overlaps } from './handlers/classes.js';
import { fullName } from './utils.js';

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

// Lists ACTIVE classes (same term) whose ACTIVE schedules overlap on the same
// day and share a room, an instructor or a section. Read-only. Uses the same
// overlap rule as creating a class/schedule (classes.js), so this finds clashes
// saved before that rule existed (e.g. BUG-3) or typed into the Sheet by hand.
export function findScheduleClashes(db) {
  const classes = new Map(db.Classes.filter((row) => row.status === 'active').map((row) => [row.class_id, row]));
  const rooms = new Map(db.Rooms.map((row) => [row.room_id, row.room_code]));
  const instructors = new Map(db.Instructors.map((row) => [row.instructor_id, fullName(row)]));
  const sections = new Map(db.Sections.map((row) => [row.section_id, row.section_name]));
  const slots = db.Schedules.filter((row) => row.status === 'active' && classes.has(row.class_id));
  const lines = [];
  slots.forEach((a, i) => {
    slots.slice(i + 1).forEach((b) => {
      const ca = classes.get(a.class_id);
      const cb = classes.get(b.class_id);
      if (ca.class_id === cb.class_id || ca.term_id !== cb.term_id || !overlaps(a, b)) return;
      const shared = [];
      if (a.room_id === b.room_id) shared.push(`room ${rooms.get(a.room_id) ?? a.room_id}`);
      if (ca.instructor_id === cb.instructor_id) shared.push(`instructor ${instructors.get(ca.instructor_id) || ca.instructor_id}`);
      if (ca.section_id === cb.section_id) shared.push(`section ${sections.get(ca.section_id) ?? ca.section_id}`);
      if (!shared.length) return;
      lines.push(`${ca.class_label} (${a.schedule_id}, ${a.day_of_week} ${a.start_time}-${a.end_time}) and `
        + `${cb.class_label} (${b.schedule_id}, ${b.day_of_week} ${b.start_time}-${b.end_time}) share ${shared.join(', ')}`);
    });
  });
  return lines;
}
