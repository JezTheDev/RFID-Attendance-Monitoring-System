// Step 4f: tests the REAL deployed Web App the way the ESP32 does (spec 3.1, 6, 8.1).
// Needs a TEST Sheet prepared with prepareLiveTest() (see backend/README.md "Live test (4f)").
// Usage: set API_URL, DEVICE_ID, DEVICE_KEY, LIVE_UIDS (comma list), NOT_ENROLLED_UID,
// UNKNOWN_UID in the environment, then: node tools/live_device_test.mjs
// The key is read from the environment only and never printed.
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// POST JSON; Apps Script answers 302 -> GET the Location with a NEW request (spec 3.1).
// Returns { status, json (null if the body is not JSON), ms } and never throws.
export async function postDevice(url, body) {
  const t0 = performance.now();
  let status = 0;
  let text = '';
  try {
    let res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual' });
    if (res.status === 302) {
      const location = new URL(res.headers.get('location'), url);
      await res.arrayBuffer();
      res = await fetch(location);
    }
    status = res.status;
    text = await res.text();
  } catch (error) {
    text = '';
    status = `network error (${error.cause?.code || error.name})`;
  }
  let json = null;
  try { json = status === 200 ? JSON.parse(text) : null; } catch { json = null; }
  return { status, json, ms: performance.now() - t0 };
}

// What a reply "is": the scan result, the request error code, or why it is unusable.
function outcome(reply, index = 0) {
  if (!reply.json) return reply.status === 200 ? 'not JSON' : `HTTP ${reply.status}`;
  if (!reply.json.ok) return reply.json.error?.code || 'ok:false';
  return reply.json.data?.results?.[index]?.result ?? 'ok';
}

const tally = (list) => {
  const counts = {};
  list.forEach((v) => { counts[v] = (counts[v] || 0) + 1; });
  return Object.keys(counts).sort().map((k) => `${counts[k]} ${k}`).join(', ');
};

export async function runLiveTest({ url, deviceId, key, uids, notEnrolledUid, unknownUid, post = postDevice }) {
  const boot = String(Math.floor(Date.now() / 1000) % 1e6).padStart(6, '0'); // new per run: no ALREADY_RECORDED on reruns
  let seq = 0;
  const nowSec = () => Math.floor(Date.now() / 1000);
  const scan = (uid, syncMode = 'live', scannedAt = nowSec()) => ({
    scan_id: `${deviceId}-${boot}-${String(seq += 1).padStart(6, '0')}`, rfid_uid: uid, scanned_at: scannedAt, time_quality: 'ntp', sync_mode: syncMode,
  });
  const auth = { device_id: deviceId, device_key: key };
  const submit = (scans, deviceKey = key) => post(url, { action: 'device.submitScans', ...auth, device_key: deviceKey, sent_at: nowSec(), firmware_version: 'live-test', scans });

  // Expected results, computed as we go: first scan of an enrolled UID = ACCEPTED, later = DUPLICATE.
  const present = new Set();
  const expect = (uid) => {
    if (uid === notEnrolledUid) return 'NOT_ENROLLED';
    if (!uids.includes(uid)) return 'UNREGISTERED';
    if (present.has(uid)) return 'DUPLICATE';
    present.add(uid);
    return 'ACCEPTED';
  };

  const rows = [];
  const timing = {}; // single-scan request ms by the result the server gave
  let serverBusy = 0;
  const add = (test, expected, got, pass, ms) => rows.push({ test, expected, got, pass, ms: [].concat(ms) });
  const single = async (test, item, want = expect(item.rfid_uid)) => {
    const reply = await submit([item]);
    const got = outcome(reply);
    (timing[got] ||= []).push(reply.ms);
    add(test, want, got, got === want, reply.ms);
    return reply;
  };

  let r = await post(url, { action: 'device.heartbeat', ...auth, sent_at: nowSec(), battery_voltage: 3.9, wifi_rssi: -60, queue_count: 0, time_synced: true, firmware_version: 'live-test', uptime_seconds: 60 });
  add('heartbeat', 'ok + roster_version', outcome(r), outcome(r) === 'ok' && Number.isInteger(r.json.data.roster_version), r.ms);

  r = await post(url, { action: 'device.getRoster', ...auth, known_version: 0 });
  const roster = new Set((r.json?.data?.cards || []).map((c) => c.uid));
  const missing = uids.filter((uid) => !roster.has(uid)).length;
  add('getRoster (known_version 0)', 'changed, has all LIVE_UIDS', outcome(r) === 'ok' ? `changed=${r.json.data.changed}, ${roster.size} cards, ${missing} missing` : outcome(r),
    outcome(r) === 'ok' && r.json.data.changed === true && missing === 0, r.ms);

  const first = scan(uids[0]);
  await single('live scan', first);
  r = await submit([first]);
  add('same scan_id again', 'ALREADY_RECORDED', outcome(r), outcome(r) === 'ALREADY_RECORDED', r.ms);
  await single('same student, new scan_id', scan(uids[0]));
  await single('not-enrolled UID', scan(notEnrolledUid));
  await single('unknown UID', scan(unknownUid));

  // Offline batch: half of the not-yet-scanned students (real saves), the rest repeats (DUPLICATE).
  // The other half stays for the 40 sequential scans, so we time real saves there too.
  const fresh = uids.filter((uid) => !present.has(uid));
  const batchUids = fresh.slice(0, Math.min(20, Math.ceil(fresh.length / 2)));
  while (batchUids.length < 20) batchUids.push(uids[batchUids.length % uids.length]);
  const batch = batchUids.map((uid, i) => scan(uid, 'offline', nowSec() - 120 + i));
  const batchWant = batch.map((s) => expect(s.rfid_uid));
  r = await submit(batch);
  const batchGot = r.json?.ok ? r.json.data.results.map((x) => x.result) : [outcome(r)];
  add('20-scan offline batch', tally(batchWant), tally(batchGot), batchGot.length === 20 && batchGot.every((g, i) => g === batchWant[i]), r.ms);

  r = await post(url, { action: 'device.heartbeat', ...auth, device_key: randomBytes(32).toString('hex'), sent_at: nowSec(), battery_voltage: 3.9, wifi_rssi: -60, queue_count: 0, time_synced: true, firmware_version: 'live-test', uptime_seconds: 60 });
  add('wrong key', 'INVALID_DEVICE_KEY', outcome(r), outcome(r) === 'INVALID_DEVICE_KEY', r.ms);

  const seqWant = [];
  const seqGot = [];
  const seqMs = [];
  for (let i = 0; i < 40; i += 1) {
    const item = scan(uids[i % uids.length]);
    const want = expect(item.rfid_uid);
    const reply = await submit([item]);
    const got = outcome(reply);
    (timing[got] ||= []).push(reply.ms);
    seqWant.push(want); seqGot.push(got); seqMs.push(reply.ms);
  }
  add('40 sequential', tally(seqWant), tally(seqGot), seqGot.every((g, i) => g === seqWant[i]), seqMs);

  // Every UID is present by now, so all 10 are DUPLICATE; SERVER_BUSY is counted, not failed.
  const parallel = Array.from({ length: 10 }, (_, i) => scan(uids[i % uids.length]));
  const parWant = parallel.map((s) => expect(s.rfid_uid));
  const replies = await Promise.all(parallel.map((s) => submit([s])));
  const parGot = replies.map((x) => outcome(x));
  replies.forEach((x, i) => { if (parGot[i] !== 'SERVER_BUSY') (timing[parGot[i]] ||= []).push(x.ms); });
  serverBusy = parGot.filter((g) => g === 'SERVER_BUSY').length;
  add('10 parallel', `${tally(parWant)} (SERVER_BUSY allowed)`, tally(parGot), parGot.every((g, i) => g === parWant[i] || g === 'SERVER_BUSY'), replies.map((x) => x.ms));

  return { rows, summary: { serverBusy, timing } };
}

const fmtMs = (list) => {
  if (!list.length) return '';
  const sorted = list.slice().sort((a, b) => a - b);
  const n = (v) => String(Math.round(v));
  return sorted.length === 1 ? n(sorted[0]) : `${n(sorted[0])} / ${n(sorted[Math.floor((sorted.length - 1) / 2)])} / ${n(sorted.at(-1))}`;
};

export function formatTable(rows, summary) {
  const table = [['test', 'expected', 'got', 'PASS/FAIL', 'ms (min / median / max)'],
    ...rows.map((r) => [r.test, r.expected, r.got, r.pass ? 'PASS' : 'FAIL', fmtMs(r.ms)])];
  const widths = table[0].map((_, c) => Math.max(...table.map((row) => row[c].length)));
  const line = (row) => row.map((cell, c) => cell.padEnd(widths[c])).join(' | ');
  const out = [line(table[0]), widths.map((w) => '-'.repeat(w)).join('-|-'), ...table.slice(1).map(line), ''];
  out.push('Single-scan request time by result (ms, min / median / max):');
  Object.keys(summary.timing).sort().forEach((k) => out.push(`  ${k.padEnd(14)} n=${String(summary.timing[k].length).padEnd(3)} ${fmtMs(summary.timing[k])}`));
  out.push('', `SERVER_BUSY replies (10 parallel): ${summary.serverBusy} of 10${summary.serverBusy ? '  <-- lock was busy; the device would retry these' : ''}`);
  const failed = rows.filter((r) => !r.pass).length;
  out.push(failed ? `${failed} test(s) FAILED` : 'All tests PASSED');
  return out.join('\n');
}

async function main() {
  const env = process.env;
  const need = ['API_URL', 'DEVICE_ID', 'DEVICE_KEY', 'LIVE_UIDS', 'NOT_ENROLLED_UID', 'UNKNOWN_UID'];
  const missing = need.filter((name) => !env[name]);
  if (missing.length) {
    console.error(`Missing environment variable(s): ${missing.join(', ')}. See backend/README.md "Live test (4f)".`);
    process.exit(2);
  }
  const uids = env.LIVE_UIDS.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  console.log(`Live test: ${env.DEVICE_ID}, ${uids.length} enrolled UID(s). This takes a minute or two...`);
  const { rows, summary } = await runLiveTest({
    url: env.API_URL, deviceId: env.DEVICE_ID, key: env.DEVICE_KEY, uids,
    notEnrolledUid: env.NOT_ENROLLED_UID.trim().toUpperCase(), unknownUid: env.UNKNOWN_UID.trim().toUpperCase(),
  });
  console.log(formatTable(rows, summary));
  if (rows.find((r) => r.test === 'live scan')?.got === 'DUPLICATE') {
    console.log('Hint: the live scan was DUPLICATE, so these students were already scanned in this session. Run cleanupLiveTest then prepareLiveTest for a fresh session.');
  }
  process.exit(rows.every((r) => r.pass) ? 0 : 1);
}

// `node --test` also picks up *_test.mjs files: do nothing there (tests import the exports).
if (!process.env.NODE_TEST_CONTEXT && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
