// RFID card assign / replace / revoke rules.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, SESSIONS, withCode, CTX } from './helpers/db.js';
import { assignCard, revokeCard } from '../src/handlers/students.js';

const rosterVersion = (db) => db.Settings.find((s) => s.key === 'roster_version').value;
const activeCards = (db, studentId) => db.RfidCards.filter((c) => c.student_id === studentId && c.status === 'active');
const fieldError = (field) => (error) => withCode('VALIDATION_ERROR')(error) && Boolean(error.fields?.[field]);

describe('assign card', () => {
  it('normalizes the UID, stores the card and bumps roster_version', () => {
    const db = makeDb();
    const result = assignCard(db, { student_id: 'STU-0002', rfid_uid: 'a1:b2:c3-d5' }, SESSIONS.admin, CTX);
    assert.equal(result.card_id, 'CRD-0002');
    assert.equal(activeCards(db, 'STU-0002')[0].rfid_uid, 'A1B2C3D5');
    assert.equal(rosterVersion(db), '2');
    assert.equal(db.AuditLog.at(-1).action, 'CARD_ASSIGN');
  });

  it('rejects a UID that is not 8, 14 or 20 hex characters', () => {
    const db = makeDb();
    assert.throws(() => assignCard(db, { student_id: 'STU-0002', rfid_uid: 'XYZ123' }, SESSIONS.admin, CTX), fieldError('rfid_uid'));
    assert.equal(db.RfidCards.length, 1);
  });

  it('rejects a UID that is active for another student', () => {
    const db = makeDb();
    assert.throws(() => assignCard(db, { student_id: 'STU-0002', rfid_uid: 'A1B2C3D4' }, SESSIONS.admin, CTX), fieldError('rfid_uid'));
    assert.equal(rosterVersion(db), '1');
  });

  it('rejects the student\'s own active card again', () => {
    const db = makeDb();
    assert.throws(() => assignCard(db, { student_id: 'STU-0001', rfid_uid: 'A1B2C3D4' }, SESSIONS.admin, CTX), fieldError('rfid_uid'));
  });

  it('rejects a UID that used to belong to another student', () => {
    const db = makeDb();
    db.RfidCards[0].status = 'revoked';
    assert.throws(() => assignCard(db, { student_id: 'STU-0002', rfid_uid: 'A1B2C3D4' }, SESSIONS.admin, CTX), fieldError('rfid_uid'));
  });

  it('refuses an inactive student', () => {
    const db = makeDb();
    db.Students[1].account_status = 'inactive';
    assert.throws(() => assignCard(db, { student_id: 'STU-0002', rfid_uid: 'A1B2C3D5' }, SESSIONS.admin, CTX), withCode('STUDENT_INACTIVE'));
  });

  it('requires a reason to replace an existing card', () => {
    const db = makeDb();
    assert.throws(() => assignCard(db, { student_id: 'STU-0001', rfid_uid: 'A1B2C3D5' }, SESSIONS.admin, CTX), fieldError('replace_reason'));
    assert.equal(activeCards(db, 'STU-0001')[0].card_id, 'CRD-0001');
  });

  it('replacing marks the old card lost and keeps exactly one active card', () => {
    const db = makeDb();
    const result = assignCard(db, { student_id: 'STU-0001', rfid_uid: 'A1B2C3D5', replace_reason: 'lost' }, SESSIONS.admin, CTX);
    assert.equal(result.replaced_card_id, 'CRD-0001');
    assert.equal(db.RfidCards[0].status, 'lost');
    assert.notEqual(db.RfidCards[0].revoked_at, '');
    assert.deepEqual(activeCards(db, 'STU-0001').map((c) => c.rfid_uid), ['A1B2C3D5']);
  });
});

describe('revoke card', () => {
  it('revokes the active card, bumps roster_version and writes the audit log', () => {
    const db = makeDb();
    revokeCard(db, { student_id: 'STU-0001', reason: 'Card stolen' }, SESSIONS.admin, CTX);
    assert.equal(db.RfidCards[0].status, 'revoked');
    assert.equal(activeCards(db, 'STU-0001').length, 0);
    assert.equal(rosterVersion(db), '2');
    assert.equal(db.AuditLog.at(-1).action, 'CARD_REVOKE');
  });

  it('fails when the student has no active card', () => {
    const db = makeDb();
    assert.throws(() => revokeCard(db, { student_id: 'STU-0002', reason: 'Card stolen' }, SESSIONS.admin, CTX), withCode('NO_ACTIVE_CARD'));
  });

  it('requires a reason of at least 3 characters', () => {
    const db = makeDb();
    assert.throws(() => revokeCard(db, { student_id: 'STU-0001', reason: 'x' }, SESSIONS.admin, CTX), fieldError('reason'));
    assert.equal(db.RfidCards[0].status, 'active');
  });
});
