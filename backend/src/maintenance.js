// Editor-only maintenance jobs (Server.gs runs them from the Apps Script editor).
// Each takes the db and returns lines to log.
import { overlaps, addSchedule, removeSchedule } from './handlers/classes.js';
import {
  AppError, fullName, manilaAt, dayCodeOf, writeAudit, bumpRosterVersion,
} from './utils.js';
import { TAB_COLUMNS } from './schema.js';

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

/* ---------- Live test (step 4f): TEST Sheet only ---------- */

const LIVE_TEST = 'LIVE_TEST_SCHEDULE';
const SYSTEM = { user_id: '', role: 'system' };

function requireTestSheet(ctx, job) {
  if (!ctx.property('TEST_SEED_PASSWORD')) {
    throw new AppError('NOT_TEST_SHEET', `${job} is for the TEST Sheet only (TEST_SEED_PASSWORD is not set).`);
  }
}

const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

// Active schedules marked by prepareLiveTest (an AuditLog row, since Schedules has no notes column).
function liveTestSchedules(db) {
  const ids = new Set(db.AuditLog.filter((row) => row.action === LIVE_TEST).map((row) => row.entity_id));
  return db.Schedules.filter((row) => ids.has(row.schedule_id) && row.status === 'active');
}

// UIDs of active cards of active students, split by enrollment in classId.
function cardsFor(db, classId) {
  const enrolled = new Set(db.Enrollments.filter((row) => row.class_id === classId && row.status === 'enrolled').map((row) => row.student_id));
  const active = new Set(db.Students.filter((row) => row.account_status === 'active').map((row) => row.student_id));
  const cards = db.RfidCards.filter((row) => row.status === 'active' && active.has(row.student_id));
  return {
    enrolled: cards.filter((row) => enrolled.has(row.student_id)).map((row) => row.rfid_uid),
    other: cards.filter((row) => !enrolled.has(row.student_id)).map((row) => row.rfid_uid),
  };
}

function liveTestResult(db, slot, reused) {
  const device = db.Devices.find((row) => row.room_id === slot.room_id && row.status === 'active');
  const { enrolled, other } = cardsFor(db, slot.class_id);
  const known = new Set(db.RfidCards.map((row) => row.rfid_uid));
  let n = 0;
  while (known.has(`FFFFFF${String(n).padStart(2, '0')}`)) n += 1;
  return {
    schedule_id: slot.schedule_id,
    device_id: device ? device.device_id : '',
    room_id: slot.room_id,
    room_code: db.Rooms.find((row) => row.room_id === slot.room_id)?.room_code ?? '',
    class_id: slot.class_id,
    class_label: db.Classes.find((row) => row.class_id === slot.class_id)?.class_label ?? '',
    day_of_week: slot.day_of_week,
    start_time: slot.start_time,
    end_time: slot.end_time,
    reused,
    enrolled_uids: enrolled,
    not_enrolled_uid: other[0],
    unknown_uid: `FFFFFF${String(n).padStart(2, '0')}`,
  };
}

// Adds a temporary ACTIVE schedule (now-10 .. now+60, today, Manila) in a room
// with an active device, for the class with the most enrolled carded students.
// Uses addSchedule, so the Admin portal's clash checks apply. Safe to run again:
// a LIVE TEST slot that still covers now is reused; older ones are deactivated.
export function prepareLiveTest(db, ctx) {
  requireTestSheet(ctx, 'prepareLiveTest');
  const now = manilaAt(ctx.now());
  const day = dayCodeOf(now.date);
  const marked = liveTestSchedules(db);
  const current = marked.find((row) => row.day_of_week === day && row.start_time <= now.time && now.time <= row.end_time);
  if (current) return liveTestResult(db, current, true);
  marked.forEach((row) => removeSchedule(db, row, SYSTEM, ctx));

  const term = db.Terms.find((row) => row.is_active === 'TRUE' && row.start_date <= now.date && now.date <= row.end_date);
  if (!term) throw new AppError('NO_LIVE_TEST_SLOT', `No active term covers ${now.date}.`);
  const rooms = [...new Set(db.Devices.filter((row) => row.status === 'active' && row.room_id).map((row) => row.room_id))].sort();
  if (!rooms.length) throw new AppError('NO_LIVE_TEST_SLOT', 'No active device with a room. Activate one in the Admin portal.');
  const classes = db.Classes
    .filter((row) => row.status === 'active' && row.term_id === term.term_id)
    .map((row) => ({ row, cards: cardsFor(db, row.class_id) }))
    .filter(({ cards }) => cards.enrolled.length && cards.other.length)
    .sort((a, b) => b.cards.enrolled.length - a.cards.enrolled.length || a.row.class_id.localeCompare(b.row.class_id));

  const minutes = Number(now.time.slice(0, 2)) * 60 + Number(now.time.slice(3));
  const slot = { day_of_week: day, start_time: hhmm(Math.max(0, minutes - 10)), end_time: hhmm(Math.min(23 * 60 + 59, minutes + 60)) };
  const reasons = [];
  for (const { row: klass } of classes) {
    for (const roomId of rooms) {
      try {
        const { schedule_id: scheduleId } = addSchedule(db, { class_id: klass.class_id, room_id: roomId, ...slot }, SYSTEM, ctx);
        writeAudit(db, SYSTEM, {
          action: LIVE_TEST, entityType: 'Schedules', entityId: scheduleId, reason: 'LIVE TEST (prepareLiveTest): run cleanupLiveTest after',
        }, ctx);
        return liveTestResult(db, db.Schedules.find((row) => row.schedule_id === scheduleId), false);
      } catch (error) {
        if (!error.fields) throw error;
        reasons.push(`${klass.class_label} in ${roomId}: ${Object.values(error.fields).join(' ')}`);
      }
    }
  }
  throw new AppError('NO_LIVE_TEST_SLOT', `No free slot ${slot.day_of_week} ${slot.start_time}-${slot.end_time}. ${reasons.join(' | ') || 'No active class has both enrolled and not-enrolled students with active cards.'}`);
}

// Sets every active LIVE TEST schedule inactive. Never deletes rows.
export function cleanupLiveTest(db, ctx) {
  requireTestSheet(ctx, 'cleanupLiveTest');
  const marked = liveTestSchedules(db);
  marked.forEach((row) => removeSchedule(db, row, SYSTEM, ctx));
  return marked.length
    ? marked.map((row) => `Set LIVE TEST schedule ${row.schedule_id} (${row.class_id}, ${row.day_of_week} ${row.start_time}-${row.end_time}) inactive.`)
    : ['Nothing to change: no active LIVE TEST schedule.'];
}

/* ---------- Wipe test data: TEST Sheet only ---------- */

// The only data rows a wipe keeps (Settings is kept whole).
const WIPE_KEEP = { Users: ['username', 'admin.test'], Rooms: ['room_code', 'RM301'], Devices: ['device_id', 'DEV-RM301-01'] };
// Columns only device.heartbeat writes: cleared on the kept device so no old (test) reading stays on the dashboard.
const WIPE_HEARTBEAT_COLUMNS = ['battery_voltage', 'wifi_rssi', 'time_synced', 'last_heartbeat_at'];

// Deletes every data row of every schema tab except Settings and the WIPE_KEEP
// rows, and bumps roster_version. confirm false = dry run: only the counts.
// Headers, tabs and the "View - …" tabs are never touched (Server.gs).
export function wipeTestData(db, ctx, confirm) {
  requireTestSheet(ctx, 'wipeTestData');
  if (!db.Users.some((row) => row.username === WIPE_KEEP.Users[1])) {
    throw new AppError('NOT_FOUND', 'admin.test is not in Users: refusing, the wipe would leave no admin to sign in.');
  }
  const lines = [confirm ? 'WIPED (CONFIRM_WIPE = YES):' : 'DRY RUN, nothing changed. Would delete:'];
  Object.keys(TAB_COLUMNS).filter((name) => name !== 'Settings').forEach((name) => {
    const rows = db[name] || [];
    const [key, value] = WIPE_KEEP[name] || [];
    const kept = rows.filter((row) => key && row[key] === value);
    lines.push(`${name}: delete ${rows.length - kept.length}, keep ${kept.length}${kept.length ? ` (${value})` : ''}`);
    if (confirm) rows.splice(0, rows.length, ...kept);
  });
  lines.push(`Devices ${WIPE_KEEP.Devices[1]}: clear ${WIPE_HEARTBEAT_COLUMNS.join(', ')} (key, room and status kept)`);
  if (confirm) db.Devices.forEach((row) => WIPE_HEARTBEAT_COLUMNS.forEach((column) => { row[column] = ''; }));
  lines.push('Kept: every header row, the Settings tab, the "View - …" tabs.');
  if (confirm) {
    bumpRosterVersion(db);
    lines.push(`roster_version is now ${db.Settings.find((row) => row.key === 'roster_version')?.value}: the ESP32 re-downloads the roster.`);
  } else {
    lines.push('To really delete: set the Script Property CONFIRM_WIPE = YES and run wipeTestData again.');
  }
  return lines;
}
