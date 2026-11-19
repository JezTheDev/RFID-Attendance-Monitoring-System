// Admin device actions (step 4b): list, create, update, status, room, key.
// A device is never deleted; retired is final. device_key_hash never leaves
// the server (lists show has_key) and is never written to the AuditLog.
import { AppError, validationError, cleanText, writeAudit, indexBy } from '../utils.js';

export const DEVICE_STATUSES = Object.freeze(['active', 'maintenance', 'retired']);

// Column order of the Devices tab.
const DEVICE_COLUMNS = [
  'device_id', 'room_id', 'device_name', 'device_key_hash', 'status', 'firmware_version',
  'battery_voltage', 'wifi_rssi', 'queue_count', 'time_synced', 'last_seen_at', 'last_heartbeat_at', 'notes',
];

// What the admin may see (and the AuditLog may store): everything but the hash.
function publicView(device) {
  const { device_key_hash: hash, ...rest } = device;
  return { ...rest, has_key: Boolean(hash) };
}

function findDevice(db, deviceId) {
  const device = db.Devices.find((row) => row.device_id === deviceId);
  if (!device) throw new AppError('NOT_FOUND', 'Device not found.');
  return device;
}

function notRetired(device) {
  if (device.status === 'retired') throw new AppError('DEVICE_RETIRED', 'This device is retired and can no longer be changed.');
}

function activeRoom(db, roomId) {
  const room = db.Rooms.find((row) => row.room_id === roomId);
  if (!room) throw validationError({ room_id: roomId ? 'Room not found.' : 'This field is required.' });
  if (room.status !== 'active') throw validationError({ room_id: 'This room is inactive.' });
  return room;
}

// Only one ACTIVE device per room.
function checkRoomFree(db, device, roomId) {
  const other = roomId && db.Devices.find((row) => row.room_id === roomId && row.status === 'active' && row.device_id !== device.device_id);
  if (other) {
    throw new AppError('ROOM_HAS_ACTIVE_DEVICE', `This room already has an active device: ${other.device_name} (${other.device_id}). Set it to maintenance first.`);
  }
}

function deviceName(value) {
  const name = cleanText(value);
  if (!name) throw validationError({ device_name: 'This field is required.' });
  if (name.length > 80) throw validationError({ device_name: 'Use 80 characters or fewer.' });
  return name;
}

export function listDevices(db) {
  const rooms = indexBy(db.Rooms, 'room_id');
  return {
    items: [...db.Devices]
      .sort((a, b) => a.device_id.localeCompare(b.device_id))
      .map((row) => ({ ...publicView(row), room_code: rooms.get(row.room_id)?.room_code ?? '' })),
  };
}

export function createDevice(db, input, session) {
  const name = deviceName(input.device_name);
  const room = activeRoom(db, input.room_id);
  // DEV-<room code>-NN; devices are never deleted, so highest + 1 is never reused.
  const prefix = `DEV-${room.room_code}-`;
  const highest = db.Devices.reduce((max, row) => {
    const rest = row.device_id.startsWith(prefix) ? row.device_id.slice(prefix.length) : '';
    return /^\d+$/.test(rest) ? Math.max(max, Number(rest)) : max;
  }, 0);
  const row = Object.fromEntries(DEVICE_COLUMNS.map((column) => [column, '']));
  Object.assign(row, {
    device_id: `${prefix}${String(highest + 1).padStart(2, '0')}`,
    room_id: room.room_id,
    device_name: name,
    status: 'maintenance', // no key yet; the admin activates it after flashing the key
    notes: cleanText(input.notes),
  });
  db.Devices.push(row);
  writeAudit(db, session, { action: 'DEVICE_CREATE', entityType: 'Devices', entityId: row.device_id, after: publicView(row) });
  return { device_id: row.device_id };
}

export function updateDevice(db, input, session) {
  const device = findDevice(db, input.device_id);
  const value = { device_name: deviceName(input.device_name), notes: cleanText(input.notes) };
  const before = publicView(device);
  Object.assign(device, value);
  writeAudit(db, session, { action: 'DEVICE_UPDATE', entityType: 'Devices', entityId: device.device_id, before, after: publicView(device) });
  return { device_id: device.device_id };
}

export function setDeviceStatus(db, { device_id: deviceId, status }, session) {
  if (!DEVICE_STATUSES.includes(status)) throw new AppError('BAD_REQUEST', 'Invalid status.');
  const device = findDevice(db, deviceId);
  notRetired(device);
  if (device.status === status) throw new AppError('NO_CHANGE', `This device is already ${status}.`);
  if (status === 'active') {
    if (!device.device_key_hash) throw new AppError('NO_DEVICE_KEY', 'This device has no key yet. Generate a key first, then activate it.');
    checkRoomFree(db, device, device.room_id);
  }
  const before = { status: device.status };
  device.status = status;
  if (status === 'retired') device.device_key_hash = ''; // a retired device can never sign in again
  writeAudit(db, session, { action: 'DEVICE_STATUS', entityType: 'Devices', entityId: device.device_id, before, after: { status } });
  return { device_id: device.device_id, status };
}

// room_id '' unassigns the device. The device_id keeps its original room code.
export function assignDeviceRoom(db, { device_id: deviceId, room_id: roomId = '' }, session) {
  const device = findDevice(db, deviceId);
  notRetired(device);
  const target = roomId ? activeRoom(db, roomId).room_id : '';
  if (device.room_id === target) throw new AppError('NO_CHANGE', 'The device is already in this room.');
  if (device.status === 'active') checkRoomFree(db, device, target);
  const before = { room_id: device.room_id };
  device.room_id = target;
  writeAudit(db, session, { action: 'DEVICE_ASSIGN_ROOM', entityType: 'Devices', entityId: device.device_id, before, after: { room_id: target } });
  return { device_id: device.device_id, room_id: target };
}

// Stores only the hash of a new key and returns the plain key ONCE. The old
// key stops working immediately. Never write the key to the Sheet, AuditLog or a log.
export function issueDeviceKey(db, ctx, device) {
  notRetired(device);
  const key = ctx.newDeviceKey();
  device.device_key_hash = ctx.deviceKeyHash(key);
  return key;
}

export function generateDeviceKey(db, { device_id: deviceId }, session, ctx) {
  const device = findDevice(db, deviceId);
  const hadKey = Boolean(device.device_key_hash);
  const key = issueDeviceKey(db, ctx, device);
  writeAudit(db, session, {
    action: 'DEVICE_KEY_GENERATE', entityType: 'Devices', entityId: device.device_id,
    reason: hadKey ? 'New key issued; the old key no longer works' : 'First key issued',
  });
  return { device_id: device.device_id, device_key: key };
}
