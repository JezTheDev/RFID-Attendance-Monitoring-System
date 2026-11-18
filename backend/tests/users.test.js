// Admin-side account management: creating accounts with usernames and default
// passwords, reset password, unlock, last-admin protection.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, SESSIONS, withCode } from './helpers/db.js';
import { makeCtx, setPassword, TEST_PROPS } from './helpers/auth.js';
import { runAction } from '../src/actions.js';
import { createStudent, updateStudent, getStudent } from '../src/handlers/students.js';
import { createInstructor, updateInstructor, listInstructors } from '../src/handlers/instructors.js';
import { createAdmin, updateAdmin, listAdmins, setAdminStatus } from '../src/handlers/admins.js';
import { studentGetProfile } from '../src/handlers/portal.js';
import { resetPassword, unlockUser } from '../src/auth/admin-users.js';

const fieldError = (field) => (error) => withCode('VALIDATION_ERROR')(error) && Boolean(error.fields?.[field]);
const userById = (db, id) => db.Users.find((u) => u.user_id === id);
const userOfLinked = (db, linked) => db.Users.find((u) => u.linked_id === linked);
const newStudent = (extra = {}) => ({ student_number: '2024000010', first_name: 'Gino', last_name: 'Dela Cruz', section_id: 'SEC-0001', ...extra });
const newInstructor = (extra = {}) => ({ username: 'carlo.d', first_name: 'Carlo', last_name: 'Diaz', department: 'CpE', ...extra });

function expectFreshAccount(ctx, user, role, defaultPassword) {
  assert.equal(user.role, role);
  assert.equal(user.must_change_password, 'TRUE');
  assert.equal(user.failed_attempts, '0');
  assert.equal(user.locked_until, '');
  assert.equal(user.account_status, 'active');
  assert.ok(ctx.verify(defaultPassword, user.password_hash));
  assert.equal('google_sub' in user, false);
}

describe('creating accounts', () => {
  it('student: username = student number, default student password, must change', () => {
    const db = makeDb();
    const ctx = makeCtx();
    const { student_id: id } = createStudent(db, newStudent(), SESSIONS.admin, ctx);
    const user = userOfLinked(db, id);
    assert.equal(user.username, '2024000010');
    expectFreshAccount(ctx, user, 'student', TEST_PROPS.DEFAULT_STUDENT_PASSWORD);
  });

  it('student: email is optional but must be valid when given', () => {
    const db = makeDb();
    const ctx = makeCtx();
    createStudent(db, newStudent({ email: '' }), SESSIONS.admin, ctx);
    assert.throws(() => createStudent(db, newStudent({ student_number: '2024000011', email: 'not-an-email' }), SESSIONS.admin, ctx), fieldError('email'));
  });

  it('student: a student number already used as ANY username is rejected', () => {
    const db = makeDb();
    const ctx = makeCtx();
    userById(db, 'USR-0003').username = '2024000010'; // an instructor happens to have this username
    assert.throws(() => createStudent(db, newStudent(), SESSIONS.admin, ctx), fieldError('student_number'));
  });

  it('instructor: username required, trimmed + lowercased, default instructor password', () => {
    const db = makeDb();
    const ctx = makeCtx();
    assert.throws(() => createInstructor(db, newInstructor({ username: '' }), SESSIONS.admin, ctx), fieldError('username'));
    assert.throws(() => createInstructor(db, newInstructor({ username: 'has space' }), SESSIONS.admin, ctx), fieldError('username'));
    assert.throws(() => createInstructor(db, newInstructor({ username: 'ab' }), SESSIONS.admin, ctx), fieldError('username'));
    const { instructor_id: id } = createInstructor(db, newInstructor({ username: '  Carlo.D ', email: '' }), SESSIONS.admin, ctx);
    const user = userOfLinked(db, id);
    assert.equal(user.username, 'carlo.d');
    expectFreshAccount(ctx, user, 'instructor', TEST_PROPS.DEFAULT_INSTRUCTOR_PASSWORD);
  });

  it('usernames are unique across ALL roles, ignoring case', () => {
    const db = makeDb();
    const ctx = makeCtx();
    assert.throws(() => createInstructor(db, newInstructor({ username: 'ADMIN' }), SESSIONS.admin, ctx), fieldError('username'));
    assert.throws(() => createInstructor(db, newInstructor({ username: '2024000001' }), SESSIONS.admin, ctx), fieldError('username'));
    assert.throws(() => createAdmin(db, { username: 'Ana', display_name: 'Ana Two' }, SESSIONS.admin, ctx), fieldError('username'));
  });

  it('admin: username + display name, default admin password, must change', () => {
    const db = makeDb();
    const ctx = makeCtx();
    const { user_id: id } = createAdmin(db, { username: 'registrar', display_name: 'Registrar Office' }, SESSIONS.admin, ctx);
    const user = userById(db, id);
    assert.equal(user.username, 'registrar');
    assert.equal(user.display_name, 'Registrar Office');
    expectFreshAccount(ctx, user, 'admin', TEST_PROPS.DEFAULT_ADMIN_PASSWORD);
  });

  it('fails with NOT_CONFIGURED and changes nothing when the default password property is missing', () => {
    const db = makeDb();
    const ctx = makeCtx({ props: { ...TEST_PROPS, DEFAULT_STUDENT_PASSWORD: '', DEFAULT_INSTRUCTOR_PASSWORD: '' } });
    const before = JSON.stringify(db);
    assert.throws(() => createStudent(db, newStudent(), SESSIONS.admin, ctx), withCode('NOT_CONFIGURED'));
    assert.throws(() => createInstructor(db, newInstructor(), SESSIONS.admin, ctx), withCode('NOT_CONFIGURED'));
    assert.equal(JSON.stringify(db), before);
  });
});

describe('updating accounts', () => {
  it('changing a student number changes the username too (and checks it is free)', () => {
    const db = makeDb();
    const ctx = makeCtx();
    const input = { student_id: 'STU-0001', student_number: '2024000099', first_name: 'Carla', last_name: 'Santos', section_id: 'SEC-0001', email: '' };
    updateStudent(db, input, SESSIONS.admin, ctx);
    assert.equal(userById(db, 'USR-0004').username, '2024000099');
    userById(db, 'USR-0002').username = '2024000098';
    assert.throws(() => updateStudent(db, { ...input, student_number: '2024000098' }, SESSIONS.admin, ctx), fieldError('student_number'));
  });

  it('instructor and admin usernames can be changed, but not to a taken one', () => {
    const db = makeDb();
    const ctx = makeCtx();
    const ana = { instructor_id: 'INS-0001', username: 'ana', first_name: 'Ana', last_name: 'Reyes', department: 'CpE', email: '' };
    updateInstructor(db, ana, SESSIONS.admin, ctx); // keeping your own username is fine
    updateInstructor(db, { ...ana, username: 'ana.reyes' }, SESSIONS.admin, ctx);
    assert.equal(userById(db, 'USR-0002').username, 'ana.reyes');
    assert.throws(() => updateInstructor(db, { ...ana, username: 'BEN' }, SESSIONS.admin, ctx), fieldError('username'));
    assert.throws(() => updateAdmin(db, { user_id: 'USR-0001', username: 'ben', display_name: 'Test Admin' }, SESSIONS.admin, ctx), fieldError('username'));
    updateAdmin(db, { user_id: 'USR-0001', username: 'head.admin', display_name: 'Test Admin' }, SESSIONS.admin, ctx);
    assert.equal(userById(db, 'USR-0001').username, 'head.admin');
  });
});

describe('admin.resetPassword', () => {
  it('sets the role default, forces a change, clears the lock and signs the user out everywhere', () => {
    const db = makeDb();
    const ctx = makeCtx();
    const ana = setPassword(db, ctx, 'USR-0002', 'AnaPass123');
    const { session_token: token } = runAction(db, { action: 'auth.login', username: 'ana', password: 'AnaPass123' }, ctx);
    ana.failed_attempts = '5';
    ana.locked_until = '2099-01-01T00:00:00+08:00';

    const result = resetPassword(db, { user_id: 'USR-0002' }, SESSIONS.admin, ctx);
    assert.deepEqual(result, { user_id: 'USR-0002', must_change_password: true, sessions_revoked: 1 });
    expectFreshAccount(ctx, ana, 'instructor', TEST_PROPS.DEFAULT_INSTRUCTOR_PASSWORD);
    assert.throws(() => runAction(db, { action: 'auth.me', session_token: token }, ctx), withCode('NOT_SIGNED_IN'));
    assert.equal(db.AuditLog.at(-1).action, 'PASSWORD_RESET');
    assert.ok(!JSON.stringify(db.AuditLog).includes(TEST_PROPS.DEFAULT_INSTRUCTOR_PASSWORD));
  });

  it('refuses your own account and unknown users', () => {
    const db = makeDb();
    const ctx = makeCtx();
    assert.throws(() => resetPassword(db, { user_id: 'USR-0001' }, SESSIONS.admin, ctx), withCode('BAD_REQUEST'));
    assert.throws(() => resetPassword(db, { user_id: 'USR-9999' }, SESSIONS.admin, ctx), withCode('NOT_FOUND'));
  });

  it('is admin-only on the server', () => {
    const db = makeDb();
    const ctx = makeCtx();
    setPassword(db, ctx, 'USR-0002', 'AnaPass123');
    const { session_token: token } = runAction(db, { action: 'auth.login', username: 'ana', password: 'AnaPass123' }, ctx);
    assert.throws(() => runAction(db, { action: 'admin.resetPassword', session_token: token, user_id: 'USR-0003' }, ctx), withCode('FORBIDDEN'));
    assert.throws(() => runAction(db, { action: 'admin.unlockUser', session_token: token, user_id: 'USR-0003' }, ctx), withCode('FORBIDDEN'));
  });
});

describe('admin.unlockUser', () => {
  it('clears the counter and the lock; NO_CHANGE when there is nothing to clear', () => {
    const db = makeDb();
    const ctx = makeCtx();
    const ana = userById(db, 'USR-0002');
    ana.failed_attempts = '5';
    ana.locked_until = '2099-01-01T00:00:00+08:00';
    assert.deepEqual(unlockUser(db, { user_id: 'USR-0002' }, SESSIONS.admin, ctx), { user_id: 'USR-0002' });
    assert.equal(ana.failed_attempts, '0');
    assert.equal(ana.locked_until, '');
    assert.equal(db.AuditLog.at(-1).action, 'USER_UNLOCKED');
    assert.throws(() => unlockUser(db, { user_id: 'USR-0002' }, SESSIONS.admin, ctx), withCode('NO_CHANGE'));
  });
});

describe('last active admin', () => {
  it('cannot be disabled', () => {
    const db = makeDb();
    const ctx = makeCtx();
    const other = { user_id: 'USR-0099', role: 'admin' };
    assert.throws(() => setAdminStatus(db, { user_id: 'USR-0001', status: 'inactive' }, other), withCode('IN_USE'));
    const { user_id: second } = createAdmin(db, { username: 'second', display_name: 'Second Admin' }, SESSIONS.admin, ctx);
    setAdminStatus(db, { user_id: second, status: 'inactive' }, SESSIONS.admin);
    assert.throws(() => setAdminStatus(db, { user_id: 'USR-0001', status: 'inactive' }, other), withCode('IN_USE'));
    setAdminStatus(db, { user_id: second, status: 'active' }, SESSIONS.admin);
    setAdminStatus(db, { user_id: 'USR-0001', status: 'inactive' }, other);
    assert.equal(userById(db, 'USR-0001').account_status, 'disabled');
  });

  it('no action can change a user\'s role (so no admin can be demoted)', () => {
    const db = makeDb();
    const ctx = makeCtx();
    updateAdmin(db, { user_id: 'USR-0001', username: 'admin', display_name: 'Test Admin', role: 'student' }, SESSIONS.admin, ctx);
    updateInstructor(db, { instructor_id: 'INS-0001', username: 'ana', first_name: 'Ana', last_name: 'Reyes', department: 'CpE', role: 'admin' }, SESSIONS.admin, ctx);
    assert.equal(userById(db, 'USR-0001').role, 'admin');
    assert.equal(userById(db, 'USR-0002').role, 'instructor');
  });
});

describe('account info in admin and portal responses', () => {
  it('shows username / must change / locked, never a hash', () => {
    const db = makeDb();
    const ctx = makeCtx();
    setPassword(db, ctx, 'USR-0002', 'AnaPass123', { mustChange: true });
    setPassword(db, ctx, 'USR-0004', 'Carla12345');
    userById(db, 'USR-0002').locked_until = '2099-01-01T00:00:00+08:00';
    const anaRow = listInstructors(db, {}, SESSIONS.admin, ctx).items.find((row) => row.instructor_id === 'INS-0001');
    assert.equal(anaRow.username, 'ana');
    assert.equal(anaRow.must_change_password, true);
    assert.equal(anaRow.locked, true);
    const responses = [
      anaRow,
      listAdmins(db, {}, SESSIONS.admin, ctx),
      getStudent(db, { student_id: 'STU-0001' }, SESSIONS.admin, ctx),
      studentGetProfile(db, {}, SESSIONS.student1, ctx),
      createStudent(db, newStudent(), SESSIONS.admin, ctx),
      createInstructor(db, newInstructor(), SESSIONS.admin, ctx),
      createAdmin(db, { username: 'registrar', display_name: 'Registrar' }, SESSIONS.admin, ctx),
    ];
    assert.equal(responses[2].account.username, '2024000001');
    const text = JSON.stringify(responses);
    for (const secret of ['v1$', 'password_hash', 'google', 'AnaPass123', 'Carla12345', ...Object.values(TEST_PROPS)]) {
      assert.ok(!text.includes(secret), `leaked: ${secret}`);
    }
  });
});
