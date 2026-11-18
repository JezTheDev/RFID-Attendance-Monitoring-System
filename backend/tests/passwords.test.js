// Password hashing: format, verification, salt, pepper, and that the Apps Script
// adapter (Utilities, signed bytes) produces exactly the same hash as node:crypto.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { nodeCrypto, TEST_PEPPER } from './helpers/auth.js';
import {
  PASSWORD_HASH_ITERATIONS, hashPassword, verifyPassword, hashIterations, constantTimeEqual,
} from '../src/auth/passwords.js';
import { appsScriptCrypto } from '../src/auth/crypto-apps-script.js';
import { toManilaIso } from '../src/utils.js';

const FORMAT = /^v1\$\d+\$[0-9a-f]{32}\$[0-9a-f]{64}$/;

describe('hashPassword / verifyPassword', () => {
  it('stores one versioned string v1$<iterations>$<salt>$<hash>', () => {
    const stored = hashPassword(nodeCrypto, TEST_PEPPER, 'Secret123');
    assert.match(stored, FORMAT);
    assert.equal(hashIterations(stored), PASSWORD_HASH_ITERATIONS);
    assert.ok(!stored.includes('Secret123'));
  });

  it('round-trips: the right password verifies, a wrong one does not', () => {
    const stored = hashPassword(nodeCrypto, TEST_PEPPER, 'Secret123');
    assert.equal(verifyPassword(nodeCrypto, TEST_PEPPER, 'Secret123', stored), true);
    assert.equal(verifyPassword(nodeCrypto, TEST_PEPPER, 'secret123', stored), false);
    assert.equal(verifyPassword(nodeCrypto, TEST_PEPPER, '', stored), false);
  });

  it('depends on the pepper', () => {
    const stored = hashPassword(nodeCrypto, TEST_PEPPER, 'Secret123');
    assert.equal(verifyPassword(nodeCrypto, 'other-pepper', 'Secret123', stored), false);
  });

  it('uses a new random salt every time', () => {
    const a = hashPassword(nodeCrypto, TEST_PEPPER, 'Secret123');
    const b = hashPassword(nodeCrypto, TEST_PEPPER, 'Secret123');
    assert.notEqual(a, b);
    assert.notEqual(a.split('$')[2], b.split('$')[2]);
  });

  it('verifies with the iteration count stored in the hash, not the current constant', () => {
    const stored = hashPassword(nodeCrypto, TEST_PEPPER, 'Secret123', 7);
    assert.equal(hashIterations(stored), 7);
    assert.equal(verifyPassword(nodeCrypto, TEST_PEPPER, 'Secret123', stored), true);
    const tampered = stored.replace('v1$7$', 'v1$8$');
    assert.equal(verifyPassword(nodeCrypto, TEST_PEPPER, 'Secret123', tampered), false);
  });

  it('treats empty, garbage or unknown-version hashes as "does not match"', () => {
    for (const stored of ['', 'abc', 'v2$5$00$00', 'v1$x$00$00', undefined]) {
      assert.equal(verifyPassword(nodeCrypto, TEST_PEPPER, 'Secret123', stored), false);
    }
  });

  it('refuses to hash without a pepper', () => {
    assert.throws(() => hashPassword(nodeCrypto, '', 'Secret123'), (e) => e.code === 'NOT_CONFIGURED');
  });

  it('one hash with the real constant is fast in Node (sanity, not the Apps Script timing)', () => {
    const start = Date.now();
    hashPassword(nodeCrypto, TEST_PEPPER, 'Secret123');
    assert.ok(Date.now() - start < 2000);
  });
});

describe('constantTimeEqual', () => {
  it('compares whole strings', () => {
    assert.equal(constantTimeEqual('abcd', 'abcd'), true);
    assert.equal(constantTimeEqual('abcd', 'abce'), false);
    assert.equal(constantTimeEqual('abcd', 'abc'), false);
    assert.equal(constantTimeEqual('', ''), true);
  });
});

describe('Apps Script crypto adapter', () => {
  // Fake of the parts of Apps Script's Utilities that the adapter uses.
  // Like the real one, it works with SIGNED bytes (-128..127) and refuses others.
  const toSigned = (buffer) => Array.from(buffer, (b) => (b > 127 ? b - 256 : b));
  globalThis.Utilities = {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    computeDigest(algorithm, value) {
      assert.equal(algorithm, 'SHA_256');
      assert.ok(Array.isArray(value), 'adapter must pass bytes');
      value.forEach((b) => { if (!Number.isInteger(b) || b < -128 || b > 127) throw new Error(`not a Java byte: ${b}`); });
      return toSigned(createHash('sha256').update(Buffer.from(value.map((b) => b & 0xff))).digest());
    },
    newBlob(text) { return { getBytes: () => toSigned(Buffer.from(String(text), 'utf8')) }; },
    getUuid: () => randomUUID(),
  };
  after(() => { delete globalThis.Utilities; });

  it('produces the same hash as node:crypto for the same salt (incl. non-ASCII passwords)', () => {
    const apps = appsScriptCrypto();
    for (const password of ['Secret123', 'Ñiño-pässwörd 9', 'p@$$w0rd']) {
      const stored = hashPassword(apps, TEST_PEPPER, password, 50);
      assert.equal(verifyPassword(nodeCrypto, TEST_PEPPER, password, stored), true, password);
      const fromNode = hashPassword(nodeCrypto, TEST_PEPPER, password, 50);
      assert.equal(verifyPassword(apps, TEST_PEPPER, password, fromNode), true, password);
    }
  });

  it('makes 32-hex-character random salts', () => {
    const apps = appsScriptCrypto();
    const a = apps.randomHex(16);
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.notEqual(a, apps.randomHex(16));
  });
});

describe('toManilaIso', () => {
  it('formats epoch ms as Manila local time with +08:00', () => {
    assert.equal(toManilaIso(Date.UTC(2026, 0, 1, 16, 0, 0)), '2026-01-02T00:00:00+08:00');
    assert.equal(toManilaIso(Date.UTC(2026, 10, 18, 1, 2, 3)), '2026-11-18T09:02:03+08:00');
  });
});
