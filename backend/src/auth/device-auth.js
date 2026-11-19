// Device authentication (step 4b): every device.* request carries device_id +
// device_key in its JSON body. Devices never use or create user sessions.
import { AppError, writeAudit } from '../utils.js';
import { constantTimeEqual } from './passwords.js';
import { issueDeviceKey } from '../handlers/devices.js';

const isText = (value) => typeof value === 'string' && value !== '';

// Returns the device row, or throws. The key is checked FIRST, so status and
// room errors are only seen by someone who already holds the right key. An
// unknown device still hashes the key and gets the same error as a wrong key,
// so nobody can find out which device IDs exist.
export function authenticateDevice(db, request, ctx) {
  const { device_id: deviceId, device_key: key } = request || {};
  if (!isText(deviceId) || !isText(key)) throw new AppError('BAD_REQUEST', 'device_id and device_key are required.');
  const device = db.Devices.find((row) => row.device_id === deviceId);
  const hash = ctx.deviceKeyHash(key);
  // A device without a key ('' hash) never matches a 64-character hash.
  if (!device || !constantTimeEqual(hash, device.device_key_hash || '')) {
    throw new AppError('INVALID_DEVICE_KEY', 'Unknown device or wrong device key.');
  }
  if (device.status !== 'active') throw new AppError('DEVICE_DISABLED', 'This device is not active. Ask the administrator.');
  if (!device.room_id) throw new AppError('DEVICE_NOT_ASSIGNED', 'This device is not assigned to a room. Ask the administrator.');
  return device;
}

// Editor-only (Server.gs issueTestDeviceKey): TEST Sheet only. TEST_SEED_PASSWORD
// is the test-Sheet marker and must never be set on the production Sheet.
export function issueTestDeviceKey(db, ctx, deviceId) {
  if (!ctx.property('TEST_SEED_PASSWORD')) {
    throw new AppError('NOT_TEST_SHEET', 'issueTestDeviceKey is for the TEST Sheet only (TEST_SEED_PASSWORD is not set). Use the Admin portal instead.');
  }
  const device = db.Devices.find((row) => row.device_id === deviceId);
  if (!device) throw new AppError('NOT_FOUND', `Device ${deviceId} not found.`);
  const key = issueDeviceKey(db, ctx, device);
  writeAudit(db, { user_id: '', role: 'system' }, {
    action: 'DEVICE_KEY_GENERATE', entityType: 'Devices', entityId: device.device_id, reason: 'Test key issued from the editor (issueTestDeviceKey)',
  });
  return { device_id: device.device_id, device_key: key };
}
