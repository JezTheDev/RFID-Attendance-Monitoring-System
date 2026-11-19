// tools/live_device_test.mjs against a small local fake of the Web App (302 -> GET, like Apps Script).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runLiveTest, formatTable, postDevice } from '../../tools/live_device_test.mjs';

const KEY = 'a'.repeat(64);
const UIDS = ['04000001', '04000002', '04000003', '04000004', '04000005'];
const OPTS = { deviceId: 'DEV-RM301-01', key: KEY, uids: UIDS, notEnrolledUid: '04000009', unknownUid: 'FFFFFF00' };

// Fake server: a tiny model of device.* (ScanLog idempotency, one attendance per UID).
// mode.noRedirect answers 200 directly; mode.notJson breaks the body; mode.lie returns
// ACCEPTED for the not-enrolled UID. Overlapping requests get SERVER_BUSY.
async function fakeServer(mode = {}) {
  const log = new Map();
  const present = new Set();
  const replies = new Map();
  let next = 0;
  let inFlight = 0;
  const scanResult = (s) => {
    if (log.has(s.scan_id)) return { scan_id: s.scan_id, result: 'ALREADY_RECORDED', original_result: log.get(s.scan_id) };
    let result;
    if (s.rfid_uid === OPTS.notEnrolledUid) result = mode.lie ? 'ACCEPTED' : 'NOT_ENROLLED';
    else if (!UIDS.includes(s.rfid_uid)) result = 'UNREGISTERED';
    else result = present.has(s.rfid_uid) ? 'DUPLICATE' : 'ACCEPTED';
    if (result === 'ACCEPTED') present.add(s.rfid_uid);
    log.set(s.scan_id, result);
    return { scan_id: s.scan_id, result };
  };
  const answer = (body) => {
    if (body.device_id !== OPTS.deviceId || body.device_key !== KEY) return { ok: false, error: { code: 'INVALID_DEVICE_KEY', message: 'x' } };
    if (body.action === 'device.heartbeat') return { ok: true, data: { roster_version: 3, low_battery: false } };
    if (body.action === 'device.getRoster') return { ok: true, data: { changed: true, roster_version: 3, cards: [...UIDS, OPTS.notEnrolledUid].map((uid) => ({ uid, name: 'X' })) } };
    return { ok: true, data: { results: body.scans.map(scanResult), roster_version: 3 } };
  };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(replies.get(req.url));
      return;
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      inFlight += 1;
      setTimeout(() => {
        const text = mode.notJson ? '<html>oops</html>' : JSON.stringify(inFlight > 1 ? { ok: false, error: { code: 'SERVER_BUSY', message: 'x' } } : answer(JSON.parse(raw)));
        inFlight -= 1;
        if (mode.noRedirect) { res.writeHead(200); res.end(text); return; }
        const path = `/r/${next += 1}`;
        replies.set(path, text);
        res.writeHead(302, { Location: path });
        res.end();
      }, 3);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/exec`, close: () => server.close() };
}

const byTest = (rows) => Object.fromEntries(rows.map((r) => [r.test, r]));

describe('tools/live_device_test.mjs', () => {
  it('happy path: every row PASS, the batch makes real saves, SERVER_BUSY is counted not failed', async () => {
    const s = await fakeServer();
    try {
      const { rows, summary } = await runLiveTest({ url: s.url, ...OPTS });
      const failed = rows.filter((r) => !r.pass);
      assert.deepEqual(failed, []);
      const t = byTest(rows);
      assert.equal(t['live scan'].got, 'ACCEPTED');
      assert.equal(t['same scan_id again'].got, 'ALREADY_RECORDED');
      assert.equal(t['same student, new scan_id'].got, 'DUPLICATE');
      assert.match(t['20-scan offline batch'].expected, /ACCEPTED/);
      assert.equal(t['40 sequential'].ms.length, 40);
      assert.match(t['10 parallel'].got, /SERVER_BUSY/);
      assert.ok(summary.serverBusy > 0);
      assert.ok(summary.timing.ACCEPTED.length > 0 && summary.timing.DUPLICATE.length > 0);
      const text = formatTable(rows, summary);
      assert.match(text, /\d+ \/ \d+ \/ \d+/); // min / median / max
      assert.match(text, /SERVER_BUSY/);
      assert.ok(!text.includes(KEY));
    } finally { s.close(); }
  });

  it('a wrong result is a FAIL', async () => {
    const s = await fakeServer({ lie: true });
    try {
      const { rows } = await runLiveTest({ url: s.url, ...OPTS });
      const row = byTest(rows)['not-enrolled UID'];
      assert.deepEqual([row.expected, row.got, row.pass], ['NOT_ENROLLED', 'ACCEPTED', false]);
    } finally { s.close(); }
  });

  it('postDevice: a 200 without redirect also works', async () => {
    const s = await fakeServer({ noRedirect: true });
    try {
      const r = await postDevice(s.url, { action: 'device.heartbeat', device_id: OPTS.deviceId, device_key: KEY });
      assert.equal(r.status, 200);
      assert.equal(r.json.ok, true);
    } finally { s.close(); }
  });

  it('a body that is not JSON is a FAIL, not a crash', async () => {
    const s = await fakeServer({ notJson: true });
    try {
      const { rows } = await runLiveTest({ url: s.url, ...OPTS });
      assert.ok(rows.every((r) => !r.pass));
      assert.match(byTest(rows).heartbeat.got, /not JSON/);
    } finally { s.close(); }
  });
});
