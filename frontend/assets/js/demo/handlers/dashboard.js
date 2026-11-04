import {
  DemoError, setting, manilaNow, dayCodeOf, isValidDate, shiftDate, indexBy, fullName,
} from '../demo-utils.js';

export function getAdminDashboard(db, { date }) {
  if (!isValidDate(date)) throw new DemoError('BAD_REQUEST', 'Please choose a valid date.');

  const now = manilaNow();
  const classes = indexBy(db.Classes, 'class_id');
  const subjects = indexBy(db.Subjects, 'subject_id');
  const rooms = indexBy(db.Rooms, 'room_id');
  const instructors = indexBy(db.Instructors, 'instructor_id');
  const students = indexBy(db.Students, 'student_id');
  const devicesById = indexBy(db.Devices, 'device_id');
  const activeTerm = db.Terms.find((term) => term.is_active === 'TRUE');
  const inTerm = Boolean(activeTerm) && date >= activeTerm.start_date && date <= activeTerm.end_date;

  const enrolledCount = (classId) => db.Enrollments.filter((row) => row.class_id === classId
    && row.status === 'enrolled' && students.get(row.student_id)?.account_status === 'active').length;

  const describe = ({ classId, roomId, start, end, status, sessionId, source }) => {
    const klass = classes.get(classId);
    const records = sessionId ? db.Attendance.filter((row) => row.session_id === sessionId) : [];
    const present = records.filter((row) => row.status === 'present').length;
    const late = records.filter((row) => row.status === 'late').length;
    const enrolled = enrolledCount(classId);
    const counted = status === 'closed' || status === 'open';
    return {
      session_id: sessionId ?? null,
      class_id: classId,
      class_label: klass?.class_label ?? classId,
      subject_title: subjects.get(klass?.subject_id)?.subject_title ?? '',
      room_code: rooms.get(roomId)?.room_code ?? roomId,
      instructor_name: fullName(instructors.get(klass?.instructor_id)),
      start_time: start,
      end_time: end,
      source,
      status,
      enrolled,
      present: counted ? present : null,
      late: counted ? late : null,
      absent: counted ? Math.max(enrolled - present - late, 0) : null,
    };
  };

  const dayCode = dayCodeOf(date);
  const scheduled = inTerm
    ? db.Schedules.filter((row) => row.status === 'active' && row.day_of_week === dayCode && classes.get(row.class_id)?.status === 'active')
    : [];

  const sessions = scheduled.map((slot) => {
    const session = db.ClassSessions.find((row) => row.schedule_id === slot.schedule_id && row.session_date === date);
    let status;
    if (session) status = session.status;
    else if (date > now.date || (date === now.date && now.time < slot.start_time)) status = 'scheduled';
    else if (date === now.date && now.time <= slot.end_time) status = 'in_progress';
    else status = 'no_record';
    return describe({
      classId: slot.class_id, roomId: slot.room_id, start: slot.start_time, end: slot.end_time,
      status, sessionId: session?.session_id, source: 'auto',
    });
  });

  db.ClassSessions
    .filter((row) => row.source === 'manual' && row.session_date === date)
    .forEach((row) => sessions.push(describe({
      classId: row.class_id, roomId: row.room_id, start: row.scheduled_start, end: row.scheduled_end,
      status: row.status, sessionId: row.session_id, source: 'manual',
    })));

  sessions.sort((a, b) => a.start_time.localeCompare(b.start_time) || a.room_code.localeCompare(b.room_code));

  const countedSessions = sessions.filter((row) => row.present !== null);
  const expected = countedSessions.reduce((sum, row) => sum + row.enrolled, 0);
  const attended = countedSessions.reduce((sum, row) => sum + row.present + row.late, 0);
  const studentsPresent = new Set(
    db.Attendance.filter((row) => row.scanned_at.slice(0, 10) === date).map((row) => row.student_id),
  ).size;

  const lowBatteryVoltage = Number(setting(db, 'low_battery_voltage', 3.5));
  const offlineAfterMs = Number(setting(db, 'device_offline_after_minutes', 10)) * 60_000;
  const devices = db.Devices.filter((row) => row.status !== 'retired').map((row) => {
    const battery = row.battery_voltage === '' ? null : Number(row.battery_voltage);
    return {
      device_id: row.device_id,
      device_name: row.device_name,
      room_code: rooms.get(row.room_id)?.room_code ?? '',
      status: row.status,
      battery_voltage: battery,
      low_battery: battery !== null && battery < lowBatteryVoltage,
      last_seen_at: row.last_seen_at || null,
      online: Boolean(row.last_seen_at) && Date.now() - Date.parse(row.last_seen_at) <= offlineAfterMs,
      queue_count: Number(row.queue_count || 0),
    };
  });

  const activeCardsByUid = new Map(db.RfidCards.filter((row) => row.status === 'active').map((row) => [row.rfid_uid, row]));
  const recentScans = db.ScanLog
    .filter((row) => row.scanned_at.slice(0, 10) === date)
    .sort((a, b) => b.scanned_at.localeCompare(a.scanned_at))
    .slice(0, 10)
    .map((row) => {
      const studentId = row.student_id || activeCardsByUid.get(row.rfid_uid)?.student_id || '';
      const device = devicesById.get(row.device_id);
      return {
        scan_id: row.scan_id,
        scanned_at: row.scanned_at,
        student_name: studentId ? fullName(students.get(studentId)) : null,
        rfid_uid: row.rfid_uid,
        room_code: rooms.get(device?.room_id)?.room_code ?? '',
        result: row.result,
        sync_mode: row.sync_mode,
      };
    });

  const activeStudents = db.Students.filter((row) => row.account_status === 'active');
  const studentsWithCard = new Set(db.RfidCards.filter((row) => row.status === 'active').map((row) => row.student_id));
  const withoutCard = activeStudents.filter((row) => !studentsWithCard.has(row.student_id)).length;
  const weekStart = shiftDate(date, -6);
  const unregisteredThisWeek = db.ScanLog.filter((row) => row.result === 'UNREGISTERED'
    && row.scanned_at.slice(0, 10) >= weekStart && row.scanned_at.slice(0, 10) <= date).length;

  const alerts = [];
  devices.filter((d) => d.low_battery).forEach((d) => alerts.push({
    level: 'danger', icon: 'battery-half', message: `${d.device_name} (${d.room_code}) battery is low at ${d.battery_voltage.toFixed(2)} V.`,
  }));
  const offlineDevices = devices.filter((d) => !d.online);
  if (offlineDevices.length) alerts.push({
    level: 'warning',
    icon: 'wifi-off',
    message: `${offlineDevices.length} device(s) offline.`,
    details: offlineDevices.map((d) => ({ label: `${d.device_name} (${d.room_code})`, since: d.last_seen_at })),
  });
  devices.filter((d) => d.queue_count > 0).forEach((d) => alerts.push({
    level: 'warning', icon: 'cloud-arrow-up', message: `${d.queue_count} offline scan(s) are still waiting to sync on ${d.device_name}.`,
  }));
  if (unregisteredThisWeek > 0) alerts.push({
    level: 'info', icon: 'credit-card-2-front', message: `${unregisteredThisWeek} unregistered card scan(s) in the 7 days up to this date.`,
  });
  if (withoutCard > 0) alerts.push({
    level: 'info', icon: 'person-exclamation', message: `${withoutCard} active student(s) do not have an RFID card assigned.`,
  });

  return {
    date,
    today: now.date,
    in_term: inTerm,
    term_name: activeTerm?.term_name ?? null,
    stats: {
      active_students: activeStudents.length,
      active_instructors: db.Instructors.filter((row) => row.account_status === 'active').length,
      active_classes: db.Classes.filter((row) => row.status === 'active').length,
      sessions_on_date: sessions.length,
      students_present: studentsPresent,
      attendance_rate: expected > 0 ? attended / expected : null,
      devices_online: devices.filter((d) => d.online).length,
      devices_total: devices.length,
    },
    sessions,
    devices,
    recent_scans: recentScans,
    alerts,
  };
}
