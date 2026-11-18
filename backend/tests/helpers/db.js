// A small, fully FAKE in-memory db for handler tests. Same shape as what
// Server.gs loadDb_() builds from the Sheet: { TabName: [ { column: 'text' } ] }.
//
//   Users:       USR-0001 admin, USR-0002 ana, USR-0003 ben, USR-0004 2024000001, USR-0005 2024000004
//   Instructors: INS-0001 Ana Reyes (USR-0002), INS-0002 Ben Cruz (USR-0003)
//   Students:    STU-0001..0003 in SEC-0001, STU-0004 in SEC-0002
//   Classes:     CLS-0001 (INS-0001, SEC-0001, RM-0001, MON 08:00-10:00)
//                CLS-0002 (INS-0002, SEC-0002, RM-0002, TUE 08:00-10:00)
//   Sessions:    SES-0001 (CLS-0001, closed): STU-0001 present, STU-0002 late, STU-0003 nothing
//                SES-0002 (CLS-0002, closed): STU-0004 present

export const SESSIONS = Object.freeze({
  admin: { user_id: 'USR-0001', role: 'admin' },
  instructorAna: { user_id: 'USR-0002', role: 'instructor' },
  instructorBen: { user_id: 'USR-0003', role: 'instructor' },
  student1: { user_id: 'USR-0004', role: 'student' },
  student4: { user_id: 'USR-0005', role: 'student' },
});

const student = (n, section, first, last) => ({
  student_id: `STU-000${n}`, student_number: `202400000${n}`, first_name: first, last_name: last,
  program_id: 'PRG-0001', year_level: '3', section_id: section, email: `s${n}@example.com`, account_status: 'active',
});

// Users have no password yet (password_hash ''); auth tests set one with setPassword().
const user = (id, username, role, linked) => ({
  user_id: id, username, email: `${id.toLowerCase()}@example.com`, role, linked_id: linked,
  account_status: 'active', password_hash: '', must_change_password: 'FALSE', failed_attempts: '0',
  locked_until: '', password_changed_at: '', created_by: '', last_login_at: '', created_at: '', updated_at: '',
  display_name: role === 'admin' ? 'Test Admin' : '',
});

export function makeDb() {
  return {
    Terms: [{ term_id: 'TRM-0001', term_name: '1st Sem', start_date: '2026-08-10', end_date: '2026-12-18', is_active: 'TRUE' }],
    Programs: [{ program_id: 'PRG-0001', program_code: 'BSCpE', program_name: 'Computer Engineering', status: 'active' }],
    Sections: [
      { section_id: 'SEC-0001', program_id: 'PRG-0001', year_level: '3', section_name: '3A', status: 'active' },
      { section_id: 'SEC-0002', program_id: 'PRG-0001', year_level: '3', section_name: '3B', status: 'active' },
    ],
    Subjects: [
      { subject_id: 'SUB-0001', subject_code: 'CPE301', subject_title: 'Microprocessors', units: '3', status: 'active' },
      { subject_id: 'SUB-0002', subject_code: 'CPE302', subject_title: 'Networks', units: '3', status: 'active' },
      { subject_id: 'SUB-0003', subject_code: 'CPE303', subject_title: 'Embedded Systems', units: '3', status: 'active' },
    ],
    Rooms: [
      { room_id: 'RM-0001', room_code: 'CPE-101', room_name: 'Lab 1', building: '', status: 'active' },
      { room_id: 'RM-0002', room_code: 'CPE-102', room_name: 'Lab 2', building: '', status: 'active' },
    ],
    Instructors: [
      { instructor_id: 'INS-0001', first_name: 'Ana', last_name: 'Reyes', email: 'ana@example.com', department: 'CpE', account_status: 'active' },
      { instructor_id: 'INS-0002', first_name: 'Ben', last_name: 'Cruz', email: 'ben@example.com', department: 'CpE', account_status: 'active' },
    ],
    Students: [
      student(1, 'SEC-0001', 'Carla', 'Santos'),
      student(2, 'SEC-0001', 'Dino', 'Garcia'),
      student(3, 'SEC-0001', 'Ella', 'Lim'),
      student(4, 'SEC-0002', 'Fe', 'Tan'),
    ],
    Users: [
      user('USR-0001', 'admin', 'admin', ''),
      user('USR-0002', 'ana', 'instructor', 'INS-0001'),
      user('USR-0003', 'ben', 'instructor', 'INS-0002'),
      user('USR-0004', '2024000001', 'student', 'STU-0001'),
      user('USR-0005', '2024000004', 'student', 'STU-0004'),
    ],
    RfidCards: [
      { card_id: 'CRD-0001', rfid_uid: 'A1B2C3D4', student_id: 'STU-0001', status: 'active', assigned_at: '2026-08-10T08:00:00+08:00', revoked_at: '', notes: '' },
    ],
    Devices: [],
    Classes: [
      { class_id: 'CLS-0001', term_id: 'TRM-0001', subject_id: 'SUB-0001', section_id: 'SEC-0001', instructor_id: 'INS-0001', class_label: 'CPE301 3A', late_grace_minutes: '15', status: 'active' },
      { class_id: 'CLS-0002', term_id: 'TRM-0001', subject_id: 'SUB-0002', section_id: 'SEC-0002', instructor_id: 'INS-0002', class_label: 'CPE302 3B', late_grace_minutes: '15', status: 'active' },
    ],
    Schedules: [
      { schedule_id: 'SCH-0001', class_id: 'CLS-0001', room_id: 'RM-0001', day_of_week: 'MON', start_time: '08:00', end_time: '10:00', status: 'active' },
      { schedule_id: 'SCH-0002', class_id: 'CLS-0002', room_id: 'RM-0002', day_of_week: 'TUE', start_time: '08:00', end_time: '10:00', status: 'active' },
    ],
    Enrollments: [
      { enrollment_id: 'ENR-0001', class_id: 'CLS-0001', student_id: 'STU-0001', status: 'enrolled', enrolled_at: '' },
      { enrollment_id: 'ENR-0002', class_id: 'CLS-0001', student_id: 'STU-0002', status: 'enrolled', enrolled_at: '' },
      { enrollment_id: 'ENR-0003', class_id: 'CLS-0001', student_id: 'STU-0003', status: 'enrolled', enrolled_at: '' },
      { enrollment_id: 'ENR-0004', class_id: 'CLS-0002', student_id: 'STU-0004', status: 'enrolled', enrolled_at: '' },
    ],
    ClassSessions: [
      session('SES-0001', 'CLS-0001', 'RM-0001', 'SCH-0001', '2026-11-16'),
      session('SES-0002', 'CLS-0002', 'RM-0002', 'SCH-0002', '2026-11-17'),
    ],
    Attendance: [
      attendance('ATT-00001', 'SES-0001', 'STU-0001', 'present'),
      attendance('ATT-00002', 'SES-0001', 'STU-0002', 'late'),
      attendance('ATT-00003', 'SES-0002', 'STU-0004', 'present'),
    ],
    ScanLog: [],
    AuditLog: [],
    AuthSessions: [],
    Settings: [
      { key: 'roster_version', value: '1', description: '', source: '' },
      { key: 'session_token_hours', value: '8', description: '', source: '' },
      { key: 'max_login_attempts', value: '5', description: '', source: '' },
      { key: 'lockout_minutes', value: '15', description: '', source: '' },
    ],
  };
}

function session(id, classId, roomId, scheduleId, date) {
  return {
    session_id: id, class_id: classId, room_id: roomId, schedule_id: scheduleId, session_date: date,
    scheduled_start: '08:00', scheduled_end: '10:00', actual_start: '', actual_end: '',
    source: 'auto', status: 'closed', opened_by: '', closed_by: '', override_reason: '', created_at: '',
  };
}

function attendance(id, sessionId, studentId, status) {
  return {
    attendance_id: id, session_id: sessionId, student_id: studentId, card_id: '', rfid_uid: '', device_id: 'DEV-0001',
    scan_id: '', scanned_at: '2026-11-16T08:05:00+08:00', received_at: '', status, source: 'device',
    sync_mode: 'online', time_quality: '', created_by: '',
  };
}

// assert.throws() matcher: the handler threw an AppError with this code.
export const withCode = (code) => (error) => {
  if (error?.code !== code) throw new Error(`expected error code ${code}, got ${error?.code}: ${error?.message}`);
  return true;
};
