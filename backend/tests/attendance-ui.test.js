// Pure helpers of frontend/assets/js/components/attendance-ui.js (session phase,
// "Not yet", read-only classes, CSV). ui.js touches window at load, so stub it.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let ui;
before(async () => {
  globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {} }) };
  ui = await import('../../frontend/assets/js/components/attendance-ui.js');
});

const row = (phase, extra = {}) => ({
  session_id: 'SES-1', phase, status: 'open', enrolled: 5, present: 2, late: 1, absent: 0, not_scanned: 2, ...extra,
});

describe('phaseBadge uses phase, not the stored status', () => {
  it('an open session that has ended reads Completed', () => {
    assert.match(ui.phaseBadge(row('ended')), /Completed/);
    assert.doesNotMatch(ui.phaseBadge(row('ended')), /Open/);
  });
  it('slots with no session row say no scans', () => {
    assert.match(ui.phaseBadge(row('in_progress', { session_id: null })), /no scans yet/);
    assert.match(ui.phaseBadge(row('ended', { session_id: null })), /No scans recorded/);
  });
});

describe('sessionOptionLabel', () => {
  it('describes each phase', () => {
    assert.equal(ui.sessionOptionLabel(row('ended', { not_scanned: 0, absent: 2 })), '3/5 attended');
    assert.equal(ui.sessionOptionLabel(row('in_progress')), 'In progress · 3/5 in');
    assert.equal(ui.sessionOptionLabel(row('upcoming')), 'Upcoming');
    assert.equal(ui.sessionOptionLabel(row('cancelled', { status: 'cancelled' })), 'Cancelled');
  });
});

describe('statusFilters', () => {
  const students = ['present', 'late', 'absent', 'not_scanned', 'not_scanned'].map((status) => ({ status }));
  it('keeps Not yet and Absent apart while the class runs', () => {
    assert.deepEqual(ui.statusFilters(row('in_progress'), students), [
      ['all', 'All', 5], ['present', 'Present', 1], ['late', 'Late', 1], ['not_scanned', 'Not yet', 2], ['absent', 'Absent', 1],
    ]);
  });
  it('has no Not yet filter once the class ended', () => {
    const ended = students.map((s) => ({ status: s.status === 'not_scanned' ? 'absent' : s.status }));
    assert.deepEqual(ui.statusFilters(row('ended'), ended).map(([value, , n]) => [value, n]), [
      ['all', 5], ['present', 1], ['late', 1], ['absent', 3],
    ]);
  });
});

describe('canCorrect', () => {
  const active = { status: 'active' };
  it('allows a started or ended session of an active class', () => {
    assert.equal(ui.canCorrect(row('in_progress'), active), true);
    assert.equal(ui.canCorrect(row('ended'), active), true);
  });
  it('refuses upcoming, cancelled, and inactive (read-only) classes', () => {
    assert.equal(ui.canCorrect(row('upcoming'), active), false);
    assert.equal(ui.canCorrect(row('cancelled', { status: 'cancelled' }), active), false);
    assert.equal(ui.canCorrect(row('ended'), { status: 'inactive' }), false);
  });
});

describe('recentActivityHtml (instructor.getRecentActivity)', () => {
  const item = (extra = {}) => ({
    attendance_id: 'ATT-1', session_id: 'SES-1', session_date: '2026-11-16', class_id: 'CLS-1', class_label: 'CPE301 3A',
    student_id: 'STU-1', student_number: '2024000001', student_name: 'Carla Santos', scanned_at: '2026-11-16T08:05:00+08:00',
    status: 'present', source: 'device', sync_mode: 'online', corrected: false, ...extra,
  });
  const link = (row) => `#${row.session_id}`;

  it('lists each row with student, class, status and a link to its session', () => {
    const html = ui.recentActivityHtml({ limit: 10, has_more: false, items: [item()] }, link);
    assert.match(html, /Carla Santos/);
    assert.match(html, /CPE301 3A/);
    assert.match(html, /Present/);
    assert.match(html, /href="#SES-1"/);
    assert.match(html, /8:05/);
  });
  it('escapes names and tags corrected, manual and offline rows', () => {
    const html = ui.recentActivityHtml({ limit: 10, has_more: true, items: [
      item({ student_name: '<b>x</b>', corrected: true }),
      item({ attendance_id: 'ATT-2', source: 'manual', sync_mode: '' }),
      item({ attendance_id: 'ATT-3', sync_mode: 'offline' }),
    ] }, link);
    assert.doesNotMatch(html, /<b>x<\/b>/);
    assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
    assert.match(html, /Corrected/);
    assert.match(html, /Manual/);
    assert.match(html, /Offline sync/);
    assert.match(html, /latest 10/);
  });
  it('shows an empty state', () => {
    assert.match(ui.recentActivityHtml({ limit: 10, has_more: false, items: [] }, link), /No attendance yet/);
  });
});

describe('csvText', () => {
  it('neutralises formulas, quotes commas, and starts with a BOM', () => {
    assert.equal(ui.csvText([['=1+1', 'a,b', '-5', 'ok']]), '﻿\'=1+1,"a,b",\'-5,ok');
  });
});
