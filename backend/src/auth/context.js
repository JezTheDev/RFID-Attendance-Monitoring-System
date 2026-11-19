// The "ctx" every auth-aware handler receives: hashing, Script Properties and
// the clock, injected so the same code runs in Apps Script and in Node tests.
import { AppError } from '../utils.js';
import { PASSWORD_HASH_ITERATIONS, hashPassword, verifyPassword, sha256Hex, generateTempPassword } from './passwords.js';

function notConfigured(name) {
  return new AppError('NOT_CONFIGURED', `The server is missing the ${name} setting. Ask the administrator to finish the setup.`);
}

// crypto: see passwords.js. getProperty(name) -> string|null. now() -> epoch ms.
export function createAuthContext({ crypto, getProperty, now, iterations = PASSWORD_HASH_ITERATIONS }) {
  const property = (name) => String(getProperty(name) ?? '');
  const pepper = () => {
    const value = property('PASSWORD_PEPPER');
    if (!value) throw notConfigured('PASSWORD_PEPPER');
    return value;
  };
  return {
    iterations,
    now: () => Number(now()),
    property,
    pepper,
    hash: (password) => hashPassword(crypto, pepper(), password, iterations),
    verify: (password, stored) => verifyPassword(crypto, pepper(), password, stored),
    newTempPassword: () => generateTempPassword(crypto),
    newToken: () => crypto.randomHex(32),
    tokenHash: (token) => sha256Hex(crypto, token),
    // Device keys are 32 random bytes, not human passwords: nobody can guess
    // them, so ONE peppered SHA-256 is enough. The 300-iteration password hash
    // would add ~360 ms to every tap without making the key any safer.
    newDeviceKey: () => crypto.randomHex(32),
    deviceKeyHash: (key) => sha256Hex(crypto, `${pepper()}\u0000${key}`),
  };
}
