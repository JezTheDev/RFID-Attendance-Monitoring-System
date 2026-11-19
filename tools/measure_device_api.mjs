// Rows read/written per device.* action in the fake Apps Script (steps 4d-4f).
// Usage: node tools/measure_device_api.mjs [repo-path]   (default: current folder)
// "padded" fills ScanLog and Attendance to 5,000 rows each (a busy term).
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const repo = path.resolve(process.argv[2] || '.');
const { makeServer, SEED } = await import(pathToFileURL(`${repo}/backend/tests/helpers/fake-apps-script.js`).href);

const MON = Date.parse('2026-11-23T07:40:00+08:00');
function server(padTo) {
  const s = makeServer();
  s.context.setupSheets();
  const call = (body) => { const r = s.post(body); if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.data; };
  let token = call({ action: 'auth.login', username: 'admin.test', password: SEED }).session_token;
  call({ action: 'auth.changePassword', session_token: token, old_password: SEED, new_password: 'NewAdmin99' });
  token = call({ action: 'auth.login', username: 'admin.test', password: 'NewAdmin99' }).session_token;
  call({ action: 'admin.setDeviceStatus', session_token: token, device_id: 'DEV-RM301-01', status: 'maintenance' });
  const { device_id: deviceId } = call({ action: 'admin.createDevice', session_token: token, device_name: 'M', room_id: 'ROM-0001' });
  const { device_key: key } = call({ action: 'admin.generateDeviceKey', session_token: token, device_id: deviceId });
  call({ action: 'admin.setDeviceStatus', session_token: token, device_id: deviceId, status: 'active' });
  if (padTo) {
    for (const [name, idCol, prefix, scanCol] of [['ScanLog', 'log_id', 'LOG', 'scan_id'], ['Attendance', 'attendance_id', 'ATT', 'scan_id']]) {
      const sheet = s.ss.getSheetByName(name);
      const head = sheet.cells[0];
      const template = sheet.cells[sheet.cells.length - 1];
      for (let n = sheet.cells.length; n <= padTo; n += 1) {
        const row = template.slice();
        row[head.indexOf(idCol)] = `${prefix}-${String(n).padStart(5, '0')}`;
        row[head.indexOf(scanCol)] = `DEV-PAD-01-000001-${String(n).padStart(6, '0')}`;
        sheet.cells.push(row);
      }
    }
  }
  const uids = s.tab('RfidCards').filter((c) => c.status === 'active').map((c) => c.rfid_uid);
  s.clock.ms = MON;
  s.resetStats();
  return { s, deviceId, key, uids };
}

function run(label, padTo, count) {
  const { s, deviceId, key, uids } = server(padTo);
  const sizes = ['ScanLog', 'Attendance'].map((n) => `${n}=${s.tab(n).length}`).join(' ');
  const scans = Array.from({ length: count }, (_, i) => ({
    scan_id: `${deviceId}-000001-${String(i + 1).padStart(6, '0')}`,
    rfid_uid: i < uids.length ? uids[i] : `FFFF${String(i).padStart(4, '0')}`,
    scanned_at: Math.floor(MON / 1000) - 300 + i, time_quality: 'ntp', sync_mode: 'live',
  }));
  const t0 = performance.now();
  const reply = s.post({ action: 'device.submitScans', device_id: deviceId, device_key: key, sent_at: Math.floor(MON / 1000), firmware_version: '0.3.0', scans });
  const ms = (performance.now() - t0).toFixed(0);
  if (!reply.ok) throw new Error(JSON.stringify(reply.error));
  const tally = {};
  reply.data.results.forEach((r) => { tally[r.result] = (tally[r.result] || 0) + 1; });
  console.log(`${label.padEnd(26)} ${String(count).padStart(2)} scan(s) | ${sizes.padEnd(28)} | tabs read ${s.stats.tabsRead.length} | rows read ${String(s.stats.rowsRead).padStart(6)} | rows written ${String(s.stats.rowsWritten).padStart(3)} | batchUpdates ${s.stats.batchUpdates} | node ${ms} ms | ${JSON.stringify(tally)}`);
  return s.stats.tabsRead;
}

const line = (label, s, reply, ms, extra = '') => console.log(
  `${label.padEnd(36)} | tabs read ${String(s.stats.tabsRead.length).padStart(2)} | rows read ${String(s.stats.rowsRead).padStart(6)} | rows written ${String(s.stats.rowsWritten).padStart(3)} | batchUpdates ${s.stats.batchUpdates} | node ${ms} ms ${extra}`,
);

function other(label, padTo, body) {
  const { s, deviceId, key } = server(padTo);
  const t0 = performance.now();
  const reply = s.post({ device_id: deviceId, device_key: key, ...body(s) });
  const ms = (performance.now() - t0).toFixed(0);
  if (!reply.ok) throw new Error(JSON.stringify(reply.error));
  line(label, s, reply, ms, `| tabs: ${[...s.stats.tabsRead].sort().join(', ')}`);
}

console.log('device.submitScans');
const tabs = run('seeded TEST Sheet', 0, 1);
run('seeded TEST Sheet', 0, 20);
run('padded (5,000 each)', 5000, 1);
run('padded (5,000 each)', 5000, 20);
console.log('tabs read:', [...tabs].sort().join(', '));

const beat = { action: 'device.heartbeat', sent_at: Math.floor(MON / 1000), battery_voltage: 3.82, wifi_rssi: -61, queue_count: 0, time_synced: true, firmware_version: '0.3.0', uptime_seconds: 5400 };
const version = (s) => Number(s.tab('Settings').find((r) => r.key === 'roster_version').value);
console.log('device.heartbeat / device.getRoster');
other('heartbeat (seeded)', 0, () => beat);
other('heartbeat (padded 5,000)', 5000, () => beat);
other('getRoster full (known_version 0)', 0, () => ({ action: 'device.getRoster', known_version: 0 }));
other('getRoster unchanged', 0, (s) => ({ action: 'device.getRoster', known_version: version(s) }));
