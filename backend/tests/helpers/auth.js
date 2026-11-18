// Test-only crypto adapter (node:crypto) with the same shape as the Apps Script
// adapter in backend/src/auth/crypto-apps-script.js.
import { createHash, randomBytes } from 'node:crypto';

export const nodeCrypto = Object.freeze({
  sha256: (bytes) => Array.from(createHash('sha256').update(Buffer.from(bytes.map((b) => b & 0xff))).digest()),
  utf8: (text) => Array.from(Buffer.from(String(text), 'utf8')),
  randomHex: (byteCount) => randomBytes(byteCount).toString('hex'),
});

export const TEST_PEPPER = 'test-pepper-not-a-secret';
