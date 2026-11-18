// Admin accounts. Unlike students and instructors, an admin has no separate
// record: the Users row is the whole account (name stored in display_name).
import {
  DemoError, validationError, manilaNow, cleanText, writeAudit, nextId,
} from '../demo-utils.js';

const NAME_PATTERN = /^\p{L}[\p{L}\p{M} .'-]*$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function admins(db) {
  return db.Users.filter((row) => row.role === 'admin');
}

function findAdmin(db, userId) {
  const row = admins(db).find((item) => item.user_id === userId);
  if (!row) throw new DemoError('NOT_FOUND', 'Administrator not found.');
  return row;
}

function validate(db, input, existing = null) {
  const errors = {};
  const value = {
    display_name: cleanText(input.display_name),
    email: cleanText(input.email).toLowerCase(),
  };
  if (!value.display_name) errors.display_name = 'This field is required.';
  else if (value.display_name.length > 80) errors.display_name = 'Use 80 characters or fewer.';
  else if (!NAME_PATTERN.test(value.display_name)) errors.display_name = 'Use letters, spaces, periods, apostrophes, or hyphens only.';
  if (!EMAIL_PATTERN.test(value.email) || value.email.length > 120) {
    errors.email = 'Enter a valid email address.';
  } else if (db.Users.some((row) => row.email.toLowerCase() === value.email && row.user_id !== existing?.user_id)) {
    errors.email = 'This email is already registered to another account.';
  }
  if (Object.keys(errors).length) throw validationError(errors);
  return value;
}

export function listAdmins(db, _request, session) {
  return {
    items: admins(db)
      .map((row) => ({
        user_id: row.user_id,
        display_name: row.display_name || 'Administrator',
        email: row.email,
        status: row.account_status === 'active' ? 'active' : 'inactive',
        google_linked: Boolean(row.google_sub),
        last_login_at: row.last_login_at || null,
        is_you: row.user_id === session.user_id,
      }))
      .sort((a, b) => a.display_name.localeCompare(b.display_name)),
  };
}

export function createAdmin(db, input, session) {
  const value = validate(db, input);
  const now = manilaNow().iso;
  const row = {
    user_id: nextId(db.Users, 'user_id', 'USR'),
    email: value.email,
    google_sub: '',
    role: 'admin',
    linked_id: '',
    account_status: 'active',
    created_by: session.user_id,
    last_login_at: '',
    created_at: now,
    updated_at: now,
    display_name: value.display_name,
  };
  db.Users.push(row);
  writeAudit(db, session, { action: 'ADMIN_CREATE', entityType: 'Users', entityId: row.user_id, after: { email: row.email, display_name: row.display_name } });
  return { user_id: row.user_id };
}

export function updateAdmin(db, input, session) {
  const row = findAdmin(db, input.user_id);
  const value = validate(db, input, row);
  const before = { email: row.email, display_name: row.display_name || '' };
  let googleUnlinked = false;
  if (row.email !== value.email) {
    googleUnlinked = Boolean(row.google_sub);
    row.google_sub = '';
  }
  row.email = value.email;
  row.display_name = value.display_name;
  row.updated_at = manilaNow().iso;
  writeAudit(db, session, { action: 'ADMIN_UPDATE', entityType: 'Users', entityId: row.user_id, before, after: value });
  return { user_id: row.user_id, google_unlinked: googleUnlinked };
}

export function setAdminStatus(db, { user_id: userId, status }, session) {
  const row = findAdmin(db, userId);
  if (!['active', 'inactive'].includes(status)) throw new DemoError('BAD_REQUEST', 'Invalid status.');
  const current = row.account_status === 'active' ? 'active' : 'inactive';
  if (current === status) throw new DemoError('NO_CHANGE', `This administrator is already ${status}.`);
  if (status === 'inactive') {
    if (userId === session.user_id) throw new DemoError('IN_USE', 'You cannot deactivate your own account. Ask another administrator.');
    const activeAdmins = admins(db).filter((item) => item.account_status === 'active');
    if (activeAdmins.length <= 1) throw new DemoError('IN_USE', 'There must always be at least one active administrator.');
  }
  row.account_status = status === 'active' ? 'active' : 'disabled';
  row.updated_at = manilaNow().iso;
  if (status === 'inactive') {
    // Sign them out everywhere right away.
    (db.AuthSessions || []).forEach((item) => { if (item.user_id === userId) item.revoked = 'TRUE'; });
  }
  writeAudit(db, session, {
    action: status === 'active' ? 'ADMIN_ACTIVATE' : 'ADMIN_DEACTIVATE',
    entityType: 'Users', entityId: userId, before: { account_status: current }, after: { account_status: row.account_status },
  });
  return { user_id: userId, status };
}
