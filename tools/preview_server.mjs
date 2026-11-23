// Local PREVIEW of the website with FAKE data, for checking the design on a
// computer or a phone. Nothing here touches the real Google Sheet.
//
//   node tools/preview_server.mjs          (default port 8777)
//
// It runs the real backend code (Server.gs + Bundle.gs) on an in-memory fake
// Sheet filled with the TEST seed data (backend/tests/helpers/fake-apps-script.js),
// and serves frontend/ with config.js pointing at that fake backend.
// Everything resets when you stop it (Ctrl+C).
//
// Sign in with the seeded test accounts, password = SEED below:
//   admin.test · instructor01.test · 9999000001 (student)
// (first sign-in asks for a new password: any 8+ chars with letters and numbers)
import http from 'node:http';
import os from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { makeServer, SEED } = await import(pathToFileURL(join(repo, 'backend/tests/helpers/fake-apps-script.js')).href);

const backend = makeServer();
backend.context.setupSheets();

const root = join(repo, 'frontend');
const PORT = Number(process.env.PORT || 8777);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};
// Relative API address, so it also works when a phone opens http://<computer-ip>:PORT
const CONFIG_JS = `export const CONFIG = Object.freeze({
  APP_NAME: 'RFID Attendance',
  ORGANIZATION: 'Pampanga State University · Computer Engineering',
  API_URL: '/api',
  TIMEZONE: 'Asia/Manila',
});`;

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let out;
      try {
        out = backend.context.doPost({ postData: { contents: body } }).text;
      } catch (error) {
        out = JSON.stringify({ ok: false, error: { code: 'PREVIEW_ERROR', message: String(error) } });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(out);
    });
    return;
  }
  let path = decodeURIComponent(req.url.split('?')[0]);
  if (path.endsWith('/')) path += 'index.html';
  if (path === '/assets/js/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    res.end(CONFIG_JS);
    return;
  }
  const file = normalize(join(root, path));
  if (!file.startsWith(normalize(root)) || !existsSync(file)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(file));
}).listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
    .map((a) => `http://${a.address}:${PORT}`);
  console.log('\nRFID Attendance PREVIEW (fake data, resets when stopped)');
  console.log(`  On this computer : http://localhost:${PORT}`);
  lan.forEach((url) => console.log(`  On a phone (same Wi-Fi): ${url}`));
  console.log(`  Test accounts    : admin.test / instructor01.test / 9999000001, password ${SEED}`);
  console.log('  Stop             : Ctrl+C\n');
});
