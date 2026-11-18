// The action table and shared helpers that Server.gs depends on.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, READ, WRITE } from '../src/actions.js';
import { AppError, manilaNow, nextId } from '../src/utils.js';

describe('action table', () => {
  it('every action names exactly the role of its prefix (admin./instructor./student.)', () => {
    for (const [name, action] of Object.entries(ACTIONS)) {
      assert.equal(action.role, name.split('.')[0], name);
    }
  });

  it('every action has a handler and a read/write mode', () => {
    for (const [name, action] of Object.entries(ACTIONS)) {
      assert.equal(typeof action.run, 'function', name);
      assert.ok([READ, WRITE].includes(action.mode), name);
    }
  });

  it('has no demo-only or public actions', () => {
    assert.ok(Object.keys(ACTIONS).every((name) => /^(admin|instructor|student)\./.test(name)));
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
