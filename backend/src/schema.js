// The Sheet schema: every tab and its columns, in Sheet order, plus the default
// Settings rows. setupEmptySheets (production) and setupSheets (TEST) build the
// tabs from here; the FAKE seed data must use exactly these columns (test).
import { USER_COLUMNS } from './auth/admin-users.js';
import { DEVICE_COLUMNS } from './handlers/devices.js';
import { EDITABLE_SETTINGS } from './handlers/settings.js';

export const TAB_COLUMNS = Object.freeze({
  Terms: Object.freeze(['term_id', 'term_name', 'start_date', 'end_date', 'is_active']),
  Programs: Object.freeze(['program_id', 'program_code', 'program_name', 'status']),
  Sections: Object.freeze(['section_id', 'program_id', 'year_level', 'section_name', 'status']),
  Subjects: Object.freeze(['subject_id', 'subject_code', 'subject_title', 'units', 'status']),
  Rooms: Object.freeze(['room_id', 'room_code', 'room_name', 'building', 'status']),
  Instructors: Object.freeze(['instructor_id', 'first_name', 'last_name', 'email', 'department', 'account_status']),
  Students: Object.freeze(['student_id', 'student_number', 'first_name', 'last_name', 'program_id', 'year_level', 'section_id', 'email', 'account_status']),
  Users: USER_COLUMNS,
  RfidCards: Object.freeze(['card_id', 'rfid_uid', 'student_id', 'status', 'assigned_at', 'revoked_at', 'notes']),
  Devices: DEVICE_COLUMNS,
  Classes: Object.freeze(['class_id', 'term_id', 'subject_id', 'section_id', 'instructor_id', 'class_label', 'status']),
  Schedules: Object.freeze(['schedule_id', 'class_id', 'room_id', 'day_of_week', 'start_time', 'end_time', 'status']),
  Enrollments: Object.freeze(['enrollment_id', 'class_id', 'student_id', 'status', 'enrolled_at']),
  ClassSessions: Object.freeze(['session_id', 'class_id', 'room_id', 'schedule_id', 'session_date', 'scheduled_start', 'scheduled_end', 'actual_start', 'actual_end', 'source', 'status', 'opened_by', 'closed_by', 'override_reason', 'created_at']),
  Attendance: Object.freeze(['attendance_id', 'session_id', 'student_id', 'card_id', 'rfid_uid', 'device_id', 'scan_id', 'scanned_at', 'received_at', 'status', 'source', 'sync_mode', 'time_quality', 'created_by', 'override_status', 'override_by', 'override_at', 'override_reason']),
  ScanLog: Object.freeze(['log_id', 'scan_id', 'device_id', 'rfid_uid', 'scanned_at', 'received_at', 'result', 'session_id', 'student_id', 'attendance_id', 'sync_mode']),
  AuditLog: Object.freeze(['audit_id', 'timestamp', 'user_id', 'role', 'action', 'entity_type', 'entity_id', 'before_json', 'after_json', 'reason']),
  AuthSessions: Object.freeze(['token_hash', 'user_id', 'created_at', 'expires_at', 'revoked']),
  Settings: Object.freeze(['key', 'value', 'description', 'source']),
});

// roster_version starts at 1: devices download the roster when it changes, and 0
// would never be bumped into a first download.
export const DEFAULT_SETTINGS = Object.freeze([
  ...Object.entries(EDITABLE_SETTINGS).map(([key, rule]) => ({ key, value: rule.default, description: rule.description, source: 'Default' })),
  { key: 'roster_version', value: '1', description: 'System: devices re-download the roster when this changes', source: 'Default' },
].map(Object.freeze));
