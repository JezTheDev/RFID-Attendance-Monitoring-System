// Admin: every attendance row (filtered, paged) and the attendance report.
// Read-only. Counting reuses the portal helpers, so the numbers always match
// the instructor and student views.
import {
  validationError, manilaAt, indexBy, fullName, effectiveStatus, dateRange,
} from '../utils.js';
import {
  lookups, sectionLabel, rosterIds, countedSessions, heldCount, sessionCounts, rate,
} from './portal.js';
import { deviceSummaries } from './dashboard.js';

const STATUSES = ['present', 'late', 'absent'];
const GROUP_BY = ['class', 'section', 'student'];
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

function positiveInt(value, fallback, field, fields) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    fields[field] = 'Enter a whole number of 1 or more.';
    return fallback;
  }
  return number;
}

export function listAttendance(db, request) {
  const range = dateRange(request);
  const fields = {};
  const page = positiveInt(request.page, 1, 'page', fields);
  const pageSize = Math.min(positiveInt(request.page_size, DEFAULT_PAGE_SIZE, 'page_size', fields), MAX_PAGE_SIZE);
  const status = request.status || '';
  if (status && !STATUSES.includes(status)) fields.status = 'Choose Present, Late, or Absent.';
  if (Object.keys(fields).length) throw validationError(fields);

  const { class_id: classId, section_id: sectionId, student_id: studentId } = request;
  const sessions = indexBy(db.ClassSessions, 'session_id');
  const classes = indexBy(db.Classes, 'class_id');
  const rooms = indexBy(db.Rooms, 'room_id');
  const students = indexBy(db.Students, 'student_id');
  const users = indexBy(db.Users, 'user_id');

  const matches = db.Attendance.filter((row) => {
    const session = sessions.get(row.session_id);
    return range.has(session?.session_date ?? '')
      && (!classId || session?.class_id === classId)
      && (!sectionId || classes.get(session?.class_id)?.section_id === sectionId)
      && (!studentId || row.student_id === studentId)
      && (!status || effectiveStatus(row) === status);
  }).sort((a, b) => String(b.scanned_at).localeCompare(String(a.scanned_at))
    || String(b.attendance_id).localeCompare(String(a.attendance_id)));

  const rows = matches.slice((page - 1) * pageSize, page * pageSize).map((row) => {
    const session = sessions.get(row.session_id);
    const student = students.get(row.student_id);
    const overrideUser = users.get(row.override_by);
    return {
      attendance_id: row.attendance_id,
      session_id: row.session_id,
      session_date: session?.session_date ?? '',
      class_id: session?.class_id ?? '',
      class_label: classes.get(session?.class_id)?.class_label ?? '',
      room_code: rooms.get(session?.room_id)?.room_code ?? '',
      student_id: row.student_id,
      student_number: student?.student_number ?? '',
      student_name: fullName(student),
      scanned_at: row.scanned_at,
      status: effectiveStatus(row),
      device_status: row.status,
      source: row.source,
      sync_mode: row.sync_mode || '',
      time_quality: row.time_quality || '',
      corrected: Boolean(row.override_status),
      override_by: row.override_by || '',
      override_by_name: overrideUser ? (overrideUser.display_name || overrideUser.username) : '',
      override_at: row.override_at || '',
      override_reason: row.override_reason || '',
    };
  });
  return { range: { from: range.from, to: range.to }, page, page_size: pageSize, total: matches.length, rows };
}

const COUNT_KEYS = ['present', 'late', 'absent', 'not_scanned'];
const finish = (counts) => {
  const total = counts.present + counts.late + counts.absent;
  return { ...counts, total, rate: rate(counts.present, counts.late, total) };
};

export function getAttendanceReport(db, request, _session, ctx) {
  const groupBy = request.group_by;
  if (!GROUP_BY.includes(groupBy)) throw validationError({ group_by: 'Choose class, section, or student.' });
  const range = dateRange(request);
  const { class_id: classId, section_id: sectionId } = request;
  const now = manilaAt(ctx.now());
  const maps = lookups(db);

  const groups = new Map();
  const groupOf = (key, label) => {
    if (!groups.has(key)) {
      groups.set(key, { key, label, sessions_held: 0, students: new Set(), classes: 0, present: 0, late: 0, absent: 0, not_scanned: 0 });
    }
    return groups.get(key);
  };
  const add = (group, sessions, roster, held) => {
    group.sessions_held += held;
    group.classes += 1;
    roster.forEach((id) => group.students.add(id));
    sessions.forEach((session) => {
      const counts = sessionCounts(db, session, roster, now);
      COUNT_KEYS.forEach((key) => { group[key] += counts[key]; });
    });
  };

  db.Classes
    .filter((klass) => (!classId || klass.class_id === classId) && (!sectionId || klass.section_id === sectionId))
    .forEach((klass) => {
      const sessions = countedSessions(db, klass.class_id).filter((row) => range.has(row.session_date));
      if (klass.status !== 'active' && !sessions.length) return;
      const roster = rosterIds(db, maps, klass.class_id);
      const held = heldCount(sessions, now);
      if (groupBy === 'class') add(groupOf(klass.class_id, klass.class_label), sessions, roster, held);
      else if (groupBy === 'section') add(groupOf(klass.section_id, sectionLabel(maps, klass.section_id)), sessions, roster, held);
      else {
        roster.forEach((id) => {
          const student = maps.students.get(id);
          add(groupOf(id, `${student?.student_number ?? ''} ${fullName(student)}`.trim()), sessions, [id], held);
        });
      }
    });

  const rows = [...groups.values()]
    .map(({ students, classes, ...group }) => finish({ ...group, enrolled: groupBy === 'student' ? classes : students.size }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const sums = Object.fromEntries(COUNT_KEYS.map((key) => [key, rows.reduce((sum, row) => sum + row[key], 0)]));
  const devices = deviceSummaries(db, ctx).map((d) => ({
    device_id: d.device_id, device_name: d.device_name, room_code: d.room_code, status: d.status,
    queue_count: d.queue_count, last_seen_at: d.last_seen_at, online: d.online,
  }));

  return {
    range: { from: range.from, to: range.to },
    group_by: groupBy,
    generated_at: now.iso,
    groups: rows,
    totals: finish(sums),
    devices,
    // Scans still waiting on a device (offline queue): not in the numbers above yet.
    pending_offline_scans: devices.reduce((sum, d) => sum + d.queue_count, 0),
  };
}
