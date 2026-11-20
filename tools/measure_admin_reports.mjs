// Rows read per admin.listAttendance / admin.getAttendanceReport in the fake Apps Script.
// Usage: node tools/measure_admin_reports.mjs [repo-path]   (default: current folder)
// "padded" fills Attendance to 5,000 rows (copies of the seeded rows, new ids).
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const repo = path.resolve(process.argv[2] || '.');
const { makeServer, SEED } = await import(pathToFileURL(`${repo}/backend/tests/helpers/fake-apps-script.js`).href);

function server(padTo) {
  const s = makeServer();
  s.context.setupSheets();
  const call = (body) => { const r = s.post(body); if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.data; };
  let token = call({ action: 'auth.login', username: 'admin.test', password: SEED }).session_token;
  call({ action: 'auth.changePassword', session_token: token, old_password: SEED, new_password: 'NewAdmin99' });
  token = call({ action: 'auth.login', username: 'admin.test', password: 'NewAdmin99' }).session_token;
  if (padTo) {
    const sheet = s.ss.getSheetByName('Attendance');
    const head = sheet.cells[0];
    const seeded = sheet.cells.slice(1);
    for (let n = sheet.cells.length; n <= padTo; n += 1) {
      const row = seeded[n % seeded.length].slice();
      row[head.indexOf('attendance_id')] = `ATT-${String(n).padStart(5, '0')}`;
      sheet.cells.push(row);
    }
  }
  s.resetStats();
  return { s, token };
}

function measure(label, padTo, body) {
  const { s, token } = server(padTo);
  const t0 = performance.now();
  const reply = s.post({ session_token: token, ...body });
  const ms = (performance.now() - t0).toFixed(0);
  if (!reply.ok) throw new Error(JSON.stringify(reply.error));
  const size = reply.data.total ?? reply.data.groups.length;
  console.log(`${label.padEnd(44)} | Attendance=${String(s.tab('Attendance').length).padStart(5)} | tabs read ${String(s.stats.tabsRead.length).padStart(2)} | rows read ${String(s.stats.rowsRead).padStart(6)} | rows written ${s.stats.rowsWritten} | batchUpdates ${s.stats.batchUpdates} | node ${String(ms).padStart(4)} ms | ${body.group_by ? 'groups' : 'total'} ${size}`);
}

for (const pad of [0, 5000]) {
  measure('listAttendance (no filter)', pad, { action: 'admin.listAttendance' });
  measure('listAttendance (status=absent, page_size 500)', pad, { action: 'admin.listAttendance', status: 'absent', page_size: 500 });
  for (const groupBy of ['class', 'section', 'student']) {
    measure(`getAttendanceReport group_by=${groupBy}`, pad, { action: 'admin.getAttendanceReport', group_by: groupBy });
  }
}
