// Step 4b: Devices admin, device keys, device authentication.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, SESSIONS, withCode } from './helpers/db.js';
import { makeCtx, TEST_PROPS } from './helpers/auth.js';
import {
  listDevices, createDevice, updateDevice, setDeviceStatus, assignDeviceRoom, generateDeviceKey,
} from '../src/handlers/devices.js';
import { authenticateDevice, issueTestDeviceKey } from '../src/auth/device-auth.js';
import { ACTIONS, runAction, runDeviceAction } from '../src/actions.js';
import { startSession } from '../src/auth/session.js';

const admin = SESSIONS.admin;

function setup() {
  const db = makeDb();
  db.Rooms.push({ room_id: 'RM-0009', room_code: 'OLD-1', room_name: 'Closed', building: '', status: 'inactive' });
  return { db, ctx: makeCtx() };
}

const create = (db, ctx, room_id = 'RM-0001', device_name = 'Lab 1 Reader') =>
  createDevice(db, { device_name, room_id }, admin, ctx).device_id;

// A device with a key, active in its room. Returns { id, key }.
function activeDevice(db, ctx, room_id = 'RM-0001') {
  const id = create(db, ctx, room_id);
  const key = generateDeviceKey(db, { device_id: id }, admin, ctx).device_key;
  setDeviceStatus(db, { device_id: id, status: 'active' }, admin, ctx);
  return { id, key };
}

const row = (db, id) => db.Devices.find((d) => d.device_id === id);
const auditText = (db) => JSON.stringify(db.AuditLog);

describe('device key crypto (ctx)', () => {
  it('a new key is 32 random bytes as 64 hex characters, different every time', () => {
    const ctx = makeCtx();
    const a = ctx.newDeviceKey();
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, ctx.newDeviceKey());
  });

  it('the key hash is one peppered SHA-256: same input same hash, other pepper other hash', () => {
    const ctx = makeCtx();
    const other = makeCtx({ props: { ...TEST_PROPS, PASSWORD_PEPPER: 'another-pepper' } });
    const key = ctx.newDeviceKey();
    assert.match(ctx.deviceKeyHash(key), /^[0-9a-f]{64}$/);
    assert.equal(ctx.deviceKeyHash(key), ctx.deviceKeyHash(key));
    assert.notEqual(ctx.deviceKeyHash(key), other.deviceKeyHash(key));
    assert.notEqual(ctx.deviceKeyHash(key), key);
  });
});

describe('admin device actions', () => {
  it('createDevice: id from the room code, starts in maintenance with no key', () => {
    const { db, ctx } = setup();
    const id = create(db, ctx);
    assert.equal(id, 'DEV-CPE-101-01');
    assert.equal(row(db, id).status, 'maintenance');
    assert.equal(row(db, id).device_key_hash, '');
    assert.equal(row(db, id).room_id, 'RM-0001');
    assert.equal(db.AuditLog.at(-1).action, 'DEVICE_CREATE');
  });

  it('createDevice: next number per room, never reused (also after retiring)', () => {
    const { db, ctx } = setup();
    const first = create(db, ctx);
    setDeviceStatus(db, { device_id: first, status: 'retired' }, admin, ctx);
    assert.equal(create(db, ctx), 'DEV-CPE-101-02');
    assert.equal(create(db, ctx, 'RM-0002'), 'DEV-CPE-102-01');
  });

  it('createDevice: name and an active room are required', () => {
    const { db, ctx } = setup();
    assert.throws(() => createDevice(db, { device_name: '', room_id: 'RM-0001' }, admin, ctx), (e) => e.code === 'VALIDATION_ERROR' && !!e.fields.device_name);
    assert.throws(() => createDevice(db, { device_name: 'X', room_id: 'RM-0009' }, admin, ctx), (e) => e.code === 'VALIDATION_ERROR' && !!e.fields.room_id);
    assert.throws(() => createDevice(db, { device_name: 'X', room_id: 'RM-7777' }, admin, ctx), (e) => e.code === 'VALIDATION_ERROR' && !!e.fields.room_id);
    assert.throws(() => createDevice(db, { device_name: 'X', room_id: '' }, admin, ctx), (e) => e.code === 'VALIDATION_ERROR' && !!e.fields.room_id);
  });

  it('updateDevice changes name and notes only', () => {
    const { db, ctx } = setup();
    const id = create(db, ctx);
    updateDevice(db, { device_id: id, device_name: 'Front Reader', notes: 'by the door', status: 'active', room_id: 'RM-0002' }, admin, ctx);
    assert.equal(row(db, id).device_name, 'Front Reader');
    assert.equal(row(db, id).notes, 'by the door');
    assert.equal(row(db, id).status, 'maintenance');
    assert.equal(row(db, id).room_id, 'RM-0001');
    assert.throws(() => updateDevice(db, { device_id: 'DEV-NOPE-01', device_name: 'x' }, admin, ctx), withCode('NOT_FOUND'));
  });

  it('activating needs a key first', () => {
    const { db, ctx } = setup();
    const id = create(db, ctx);
    assert.throws(() => setDeviceStatus(db, { device_id: id, status: 'active' }, admin, ctx), (e) => e.code === 'NO_DEVICE_KEY' && /generate a key/i.test(e.message));
  });

  it('only one ACTIVE device per room: the error names the active one', () => {
    const { db, ctx } = setup();
    const first = activeDevice(db, ctx).id;
    const second = create(db, ctx);
    generateDeviceKey(db, { device_id: second }, admin, ctx);
    assert.throws(() => setDeviceStatus(db, { device_id: second, status: 'active' }, admin, ctx),
      (e) => e.code === 'ROOM_HAS_ACTIVE_DEVICE' && e.message.includes(first) && e.message.includes('Lab 1 Reader'));
    // A device in maintenance does not block.
    setDeviceStatus(db, { device_id: first, status: 'maintenance' }, admin, ctx);
    setDeviceStatus(db, { device_id: second, status: 'active' }, admin, ctx);
    assert.equal(row(db, second).status, 'active');
  });

  it('invalid status and no-change are rejected', () => {
    const { db, ctx } = setup();
    const id = create(db, ctx);
    assert.throws(() => setDeviceStatus(db, { device_id: id, status: 'offline' }, admin, ctx), withCode('BAD_REQUEST'));
    assert.throws(() => setDeviceStatus(db, { device_id: id, status: 'maintenance' }, admin, ctx), withCode('NO_CHANGE'));
  });

  it('retired is final and clears the key hash', () => {
    const { db, ctx } = setup();
    const { id } = activeDevice(db, ctx);
    setDeviceStatus(db, { device_id: id, status: 'retired' }, admin, ctx);
    assert.equal(row(db, id).device_key_hash, '');
    assert.throws(() => setDeviceStatus(db, { device_id: id, status: 'active' }, admin, ctx), withCode('DEVICE_RETIRED'));
    assert.throws(() => generateDeviceKey(db, { device_id: id }, admin, ctx), withCode('DEVICE_RETIRED'));
    assert.throws(() => assignDeviceRoom(db, { device_id: id, room_id: 'RM-0002' }, admin, ctx), withCode('DEVICE_RETIRED'));
  });

  it('assignDeviceRoom moves a device; the id keeps its old room code', () => {
    const { db, ctx } = setup();
    const id = create(db, ctx);
    assignDeviceRoom(db, { device_id: id, room_id: 'RM-0002' }, admin, ctx);
    assert.equal(row(db, id).room_id, 'RM-0002');
    assert.equal(row(db, id).device_id, 'DEV-CPE-101-01');
    assert.throws(() => assignDeviceRoom(db, { device_id: id, room_id: 'RM-0002' }, admin, ctx), withCode('NO_CHANGE'));
    assert.throws(() => assignDeviceRoom(db, { device_id: id, room_id: 'RM-0009' }, admin, ctx), (e) => e.code === 'VALIDATION_ERROR' && !!e.fields.room_id);
    assert.equal(db.AuditLog.at(-1).action, 'DEVICE_ASSIGN_ROOM');
  });

  it('assignDeviceRoom with room_id "" unassigns', () => {
    const { db, ctx } = setup();
    const id = create(db, ctx);
    assignDeviceRoom(db, { device_id: id, room_id: '' }, admin, ctx);
    assert.equal(row(db, id).room_id, '');
  });

  it('assignDeviceRoom: an ACTIVE device cannot move into a room that has another active device', () => {
    const { db, ctx } = setup();
    const inRoom2 = activeDevice(db, ctx, 'RM-0002').id;
    const mover = activeDevice(db, ctx, 'RM-0001').id;
    assert.throws(() => assignDeviceRoom(db, { device_id: mover, room_id: 'RM-0002' }, admin, ctx),
      (e) => e.code === 'ROOM_HAS_ACTIVE_DEVICE' && e.message.includes(inRoom2));
    // A device in maintenance may move there.
    setDeviceStatus(db, { device_id: mover, status: 'maintenance' }, admin, ctx);
    assignDeviceRoom(db, { device_id: mover, room_id: 'RM-0002' }, admin, ctx);
    assert.equal(row(db, mover).room_id, 'RM-0002');
  });

  it('generateDeviceKey: shown once, only the hash is stored, never in AuditLog', () => {
    const { db, ctx } = setup();
    const id = create(db, ctx);
    const result = generateDeviceKey(db, { device_id: id }, admin, ctx);
    assert.equal(result.device_id, id);
    assert.match(result.device_key, /^[0-9a-f]{64}$/);
    assert.equal(row(db, id).device_key_hash, ctx.deviceKeyHash(result.device_key));
    const everything = JSON.stringify(db);
    assert.equal(everything.split(result.device_key).length - 1, 0, 'plain key stored somewhere');
    assert.ok(!auditText(db).includes(row(db, id).device_key_hash), 'hash in AuditLog');
    assert.equal(db.AuditLog.at(-1).action, 'DEVICE_KEY_GENERATE');
  });

  it('listDevices shows has_key and room_code, never the hash; audits never carry the hash', () => {
    const { db, ctx } = setup();
    const { id } = activeDevice(db, ctx);
    updateDevice(db, { device_id: id, device_name: 'Renamed' }, admin, ctx);
    setDeviceStatus(db, { device_id: id, status: 'maintenance' }, admin, ctx);
    assignDeviceRoom(db, { device_id: id, room_id: 'RM-0002' }, admin, ctx);
    const list = listDevices(db, {}, admin, ctx).items;
    assert.equal(list.length, 1);
    assert.equal(list[0].has_key, true);
    assert.equal(list[0].room_code, 'CPE-102');
    assert.ok(!('device_key_hash' in list[0]));
    assert.ok(!auditText(db).includes('device_key_hash'));
    assert.ok(!auditText(db).includes(row(db, id).device_key_hash));
  });

  it('non-admins cannot call any device admin action', () => {
    const { db, ctx } = setup();
    const names = Object.keys(ACTIONS).filter((name) => /Device/.test(name));
    assert.equal(names.length, 6);
    for (const userId of ['USR-0002', 'USR-0004']) {
      const { token } = startSession(db, db.Users.find((u) => u.user_id === userId), ctx);
      for (const action of names) {
        assert.throws(() => runAction(db, { action, session_token: token, device_id: 'X', room_id: 'RM-0001', device_name: 'x' }, ctx), withCode('FORBIDDEN'), action);
      }
    }
  });
});

describe('device authentication', () => {
  it('the right key for an active, assigned device returns the device', () => {
    const { db, ctx } = setup();
    const { id, key } = activeDevice(db, ctx);
    assert.equal(authenticateDevice(db, { device_id: id, device_key: key }, ctx).device_id, id);
  });

  it('unknown device and wrong key give the SAME error', () => {
    const { db, ctx } = setup();
    const { id, key } = activeDevice(db, ctx);
    const errorOf = (request) => { try { authenticateDevice(db, request, ctx); } catch (e) { return { code: e.code, message: e.message }; } return null; };
    const wrong = errorOf({ device_id: id, device_key: key.replace(/.$/, (c) => (c === '0' ? '1' : '0')) });
    const unknown = errorOf({ device_id: 'DEV-NOPE-01', device_key: key });
    assert.equal(wrong.code, 'INVALID_DEVICE_KEY');
    assert.deepEqual(unknown, wrong);
  });

  it('a device with no key never authenticates, even with an empty or blank key', () => {
    const { db, ctx } = setup();
    db.Devices.push({ device_id: 'DEV-SEED-01', room_id: 'RM-0001', device_name: 'Seed', device_key_hash: '', status: 'active' });
    assert.throws(() => authenticateDevice(db, { device_id: 'DEV-SEED-01', device_key: ' ' }, ctx), withCode('INVALID_DEVICE_KEY'));
    assert.throws(() => authenticateDevice(db, { device_id: 'DEV-SEED-01', device_key: 'abc' }, ctx), withCode('INVALID_DEVICE_KEY'));
  });

  it('missing or non-text device_id / device_key is BAD_REQUEST', () => {
    const { db, ctx } = setup();
    for (const request of [{}, { device_id: 'DEV-CPE-101-01' }, { device_key: 'x' }, { device_id: 5, device_key: 'x' }, { device_id: 'x', device_key: ['k'] }, { device_id: 'x', device_key: '' }]) {
      assert.throws(() => authenticateDevice(db, request, ctx), withCode('BAD_REQUEST'), JSON.stringify(request));
    }
  });

  it('maintenance and retired devices are DEVICE_DISABLED (only after the key is right)', () => {
    const { db, ctx } = setup();
    const { id, key } = activeDevice(db, ctx);
    setDeviceStatus(db, { device_id: id, status: 'maintenance' }, admin, ctx);
    assert.throws(() => authenticateDevice(db, { device_id: id, device_key: key }, ctx), withCode('DEVICE_DISABLED'));
    assert.throws(() => authenticateDevice(db, { device_id: id, device_key: 'f'.repeat(64) }, ctx), withCode('INVALID_DEVICE_KEY'));
  });

  it('an active device with no room is DEVICE_NOT_ASSIGNED', () => {
    const { db, ctx } = setup();
    const { id, key } = activeDevice(db, ctx);
    assignDeviceRoom(db, { device_id: id, room_id: '' }, admin, ctx);
    assert.throws(() => authenticateDevice(db, { device_id: id, device_key: key }, ctx), withCode('DEVICE_NOT_ASSIGNED'));
  });

  it('rotation: the old key stops working at once, the new one works', () => {
    const { db, ctx } = setup();
    const { id, key: oldKey } = activeDevice(db, ctx);
    const newKey = generateDeviceKey(db, { device_id: id }, admin, ctx).device_key;
    assert.notEqual(newKey, oldKey);
    assert.throws(() => authenticateDevice(db, { device_id: id, device_key: oldKey }, ctx), withCode('INVALID_DEVICE_KEY'));
    assert.equal(authenticateDevice(db, { device_id: id, device_key: newKey }, ctx).device_id, id);
  });

  it('runDeviceAction: authenticates first, then UNKNOWN_ACTION; no user session involved', () => {
    const { db, ctx } = setup();
    const { id, key } = activeDevice(db, ctx);
    assert.throws(() => runDeviceAction({ Devices: db.Devices }, { action: 'device.heartbeat', device_id: id, device_key: 'bad' }, ctx), withCode('INVALID_DEVICE_KEY'));
    assert.throws(() => runDeviceAction({ Devices: db.Devices }, { action: 'device.heartbeat', device_id: id, device_key: key }, ctx), withCode('UNKNOWN_ACTION'));
    assert.equal(db.AuthSessions.length, 0);
  });
});

describe('issueTestDeviceKey (editor-only, TEST Sheet)', () => {
  it('refuses unless TEST_SEED_PASSWORD (the test-Sheet marker) is set', () => {
    const { db } = setup();
    const ctx = makeCtx({ props: { PASSWORD_PEPPER: 'p' } });
    create(db, makeCtx());
    assert.throws(() => issueTestDeviceKey(db, ctx, 'DEV-CPE-101-01'), withCode('NOT_TEST_SHEET'));
    assert.equal(row(db, 'DEV-CPE-101-01').device_key_hash, '');
  });

  it('issues a working key on a TEST Sheet and audits it as system', () => {
    const { db, ctx } = setup();
    const id = create(db, ctx);
    const { device_key } = issueTestDeviceKey(db, ctx, id);
    assert.equal(row(db, id).device_key_hash, ctx.deviceKeyHash(device_key));
    assert.equal(db.AuditLog.at(-1).role, 'system');
    assert.ok(!auditText(db).includes(device_key));
  });
});
