// The action table and shared helpers that Server.gs depends on.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, READ, WRITE } from '../src/actions.js';
import { PUBLIC, ANY } from '../src/auth/session.js';
import { AppError, manilaNow, nextId } from '../src/utils.js';

describe('action table', () => {
  it('every admin./instructor./student. action requires exactly that role', () => {
    for (const [name, action] of Object.entries(ACTIONS)) {
      if (name.startsWith('auth.')) continue;
      assert.equal(action.role, name.split('.')[0], name);
    }
  });

  it('auth actions: only login and logout are public; me and changePassword need any session', () => {
    const auth = Object.entries(ACTIONS).filter(([name]) => name.startsWith('auth.'));
    assert.deepEqual(Object.fromEntries(auth.map(([name, a]) => [name, a.role])), {
      'auth.login': PUBLIC, 'auth.logout': PUBLIC, 'auth.me': ANY, 'auth.changePassword': ANY,
    });
  });

  it('every action has a handler and a read/write mode', () => {
    for (const [name, action] of Object.entries(ACTIONS)) {
      assert.equal(typeof action.run, 'function', name);
      assert.ok([READ, WRITE].includes(action.mode), name);
    }
  });

  it('has no Google, test or demo sign-in actions', () => {
    assert.ok(Object.keys(ACTIONS).every((name) => /^(auth|admin|instructor|student)\./.test(name)));
    for (const gone of ['auth.google', 'auth.testSignIn', 'auth.demoSignIn']) assert.equal(ACTIONS[gone], undefined);
  });
});

describe('utils', () => {
  it('manilaNow() gives YYYY-MM-DD, HH:mm and an ISO time with +08:00', () => {
    const now = manilaNow();
    assert.match(now.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(now.time, /^\d{2}:\d{2}$/);
    assert.match(now.iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
    assert.ok(now.iso.startsWith(`${now.date}T${now.time}`));
  });

  it('AppError carries code and fields (Server.gs relies on error.code)', () => {
    const error = new AppError('VALIDATION_ERROR', 'Bad', { name: 'Required' });
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.deepEqual(error.fields, { name: 'Required' });
  });

  it('nextId() continues after the highest existing number', () => {
    assert.equal(nextId([{ id: 'CRD-0002' }, { id: 'CRD-0009' }], 'id', 'CRD'), 'CRD-0010');
    assert.equal(nextId([], 'id', 'ATT', 5), 'ATT-00001');
  });
});
