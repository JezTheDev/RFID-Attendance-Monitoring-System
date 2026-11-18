// The "ctx" every auth-aware handler receives: hashing, Script Properties and
// the clock, injected so the same code runs in Apps Script and in Node tests.
import { AppError } from '../utils.js';
import { PASSWORD_HASH_ITERATIONS, hashPassword, verifyPassword, sha256Hex } from './passwords.js';

export const DEFAULT_PASSWORD_PROPERTY = Object.freeze({
  student: 'DEFAULT_STUDENT_PASSWORD',
  instructor: 'DEFAULT_INSTRUCTOR_PASSWORD',
  admin: 'DEFAULT_ADMIN_PASSWORD',
});

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
    defaultPassword(role) {
      const name = DEFAULT_PASSWORD_PROPERTY[role];
      if (!name) throw new AppError('BAD_REQUEST', 'Unknown role.');
      const value = property(name);
      if (!value) throw notConfigured(name);
      return value;
    },
    newToken: () => crypto.randomHex(32),
    tokenHash: (token) => sha256Hex(crypto, token),
  };
}
