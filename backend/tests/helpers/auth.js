// Test-only crypto adapter (node:crypto) with the same shape as the Apps Script
// adapter in backend/src/auth/crypto-apps-script.js, plus a ctx with a fake clock.
import { createHash, randomBytes } from 'node:crypto';
import { createAuthContext } from '../../src/auth/context.js';

export const nodeCrypto = Object.freeze({
  sha256: (bytes) => Array.from(createHash('sha256').update(Buffer.from(bytes.map((b) => b & 0xff))).digest()),
  utf8: (text) => Array.from(Buffer.from(String(text), 'utf8')),
  randomHex: (byteCount) => randomBytes(byteCount).toString('hex'),
});

export const TEST_PEPPER = 'test-pepper-not-a-secret';

// FAKE values for tests only.
export const TEST_PROPS = Object.freeze({
  PASSWORD_PEPPER: TEST_PEPPER,
  TEST_SEED_PASSWORD: 'Seed2026x',
});

// ctx.clock.ms is the fake "now"; move it forward to test lockouts and expiry.
export function makeCtx({ props = TEST_PROPS, startMs = Date.UTC(2026, 10, 18, 0, 0, 0) } = {}) {
  const clock = { ms: startMs };
  const ctx = createAuthContext({ crypto: nodeCrypto, getProperty: (name) => props[name] ?? null, now: () => clock.ms });
  ctx.clock = clock;
  return ctx;
}

export function setPassword(db, ctx, userId, password, { mustChange = false } = {}) {
  const user = db.Users.find((row) => row.user_id === userId);
  user.password_hash = ctx.hash(password);
  user.must_change_password = mustChange ? 'TRUE' : 'FALSE';
  return user;
}

// Runs an action and returns the thrown error (fails the test if nothing is thrown).
export function errorOf(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected an error, but the call succeeded');
}
