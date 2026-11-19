// Password hashing: per-user random salt + PASSWORD_PEPPER + iterated SHA-256.
//
// Stored as ONE text cell:  v1$<iterations>$<salt hex>$<hash hex>
//   secret = UTF-8 bytes of (pepper + "\u0000" + password)
//   h0     = SHA-256( UTF-8(salt hex) ++ secret )
//   h(i)   = SHA-256( h(i-1) ++ secret )            for i = 1 .. iterations-1
//
// The iteration count is stored in each hash, so PASSWORD_HASH_ITERATIONS can be
// raised later: old hashes still verify, and a successful login re-hashes them.
//
// `crypto` is a small adapter: { sha256(bytes) -> bytes, utf8(text) -> bytes,
// randomHex(byteCount) -> string }. Apps Script: crypto-apps-script.js.
// Node tests: tests/helpers/auth.js. Bytes may be signed or unsigned.
import { AppError } from '../utils.js';

// How this number was chosen: benchmarkPasswordHash() on the real Apps Script
// project (2026-11-18) measured 1.197 ms per SHA-256 iteration (1500 iterations
// took 1629 ms). 300 iterations ~ 360 ms per hash, inside the 200-500 ms target.
// Re-run benchmarkPasswordHash() if Apps Script gets faster or slower.
// Hashes made with the earlier value (1500) still verify: the count is stored
// in each hash.
export const PASSWORD_HASH_ITERATIONS = 300;

const VERSION = 'v1';
const SALT_BYTES = 16;
const MAX_ITERATIONS = 1000000;

function toHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) hex += ((bytes[i] & 0xff) + 0x100).toString(16).slice(1);
  return hex;
}

function requirePepper(pepper) {
  if (!pepper) throw new AppError('NOT_CONFIGURED', 'The server is missing PASSWORD_PEPPER. Ask the administrator to finish the setup.');
}

function digest(crypto, pepper, password, salt, iterations) {
  const secret = crypto.utf8(`${pepper}\u0000${password}`);
  let hash = crypto.sha256(crypto.utf8(salt).concat(secret));
  for (let i = 1; i < iterations; i += 1) hash = crypto.sha256(Array.from(hash).concat(secret));
  return toHex(hash);
}

export function hashPassword(crypto, pepper, password, iterations = PASSWORD_HASH_ITERATIONS) {
  requirePepper(pepper);
  const salt = crypto.randomHex(SALT_BYTES);
  return `${VERSION}$${iterations}$${salt}$${digest(crypto, pepper, String(password), salt, iterations)}`;
}

function parse(stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) return null;
  if (!/^[0-9a-f]+$/.test(parts[2]) || !/^[0-9a-f]{64}$/.test(parts[3])) return null;
  return { iterations, salt: parts[2], hash: parts[3] };
}

export function hashIterations(stored) {
  return parse(stored)?.iterations ?? 0;
}

export function verifyPassword(crypto, pepper, password, stored) {
  requirePepper(pepper);
  const parsed = parse(stored);
  if (!parsed) return false;
  return constantTimeEqual(digest(crypto, pepper, String(password ?? ''), parsed.salt, parsed.iterations), parsed.hash);
}

// Compares every character, so the time does not show where the first difference is.
export function constantTimeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) diff |= (left.charCodeAt(i) | 0) ^ (right.charCodeAt(i) | 0);
  return diff === 0;
}

// Plain SHA-256 (hex) for session tokens: they are long and random, so no salt is needed.
export function sha256Hex(crypto, text) {
  return toHex(crypto.sha256(crypto.utf8(text)));
}

// Temporary passwords (new account / admin reset): 10 characters without the
// look-alikes 0 O o 1 l I, shown and typed as two groups: "k7Pmx-92Qwa".
const TEMP_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz'; // 56 characters
export const TEMP_PASSWORD_PATTERN = /^[2-9A-HJ-NP-Za-km-np-z]{5}-[2-9A-HJ-NP-Za-km-np-z]{5}$/;

export function generateTempPassword(crypto) {
  let chars = '';
  while (chars.length < 10) {
    const hex = crypto.randomHex(16);
    for (let i = 0; i < hex.length && chars.length < 10; i += 2) {
      const byte = parseInt(hex.slice(i, i + 2), 16);
      // 224 = 4 * 56: skipping bytes >= 224 keeps every character equally likely.
      if (byte < 224) chars += TEMP_ALPHABET[byte % 56];
    }
  }
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}
