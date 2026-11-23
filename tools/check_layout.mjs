// Layout checker: every page x width x engine against the fake API (no real API call).
// Usage: node tools/check_layout.mjs [--engine chromium|firefox|webkit|all] [--pages login,admin,instructor,student,admin/devices.html]
//          [--widths 320,375,...] [--quick] [--compare <baseline.json>] [--write-baseline <file>] [--motion reduce|no-preference]
// --quick = chromium, widths 375 and 1366, --pages required.
// Needs Playwright installed with: npm install --no-save playwright && npx playwright install
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.join(root, 'frontend');
const { chromium, firefox, webkit } = await import('playwright');
const { createLayoutApi } = await import(pathToFileURL(path.join(root, 'backend/tests/helpers/layout-api.js')).href);
const { CONFIG } = await import(pathToFileURL(path.join(FRONTEND, 'assets/js/config.js')).href);

const started = performance.now();
const ENGINES = { chromium, firefox, webkit };
const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const ALL_WIDTHS = [320, 375, 414, 768, 1024, 1366, 1920];
const PHONE_MAX = 414;
const TOUCH_MAX = 1024; // phones and tablets are touch screens; 1366+ is desktop
const listHtml = (dir) => fs.readdirSync(path.join(FRONTEND, dir)).filter((f) => f.endsWith('.html')).sort().map((f) => `${dir}/${f}`);
const GROUPS = { login: ['index.html'], admin: listHtml('admin'), instructor: listHtml('instructor'), student: listHtml('student') };

// ---- arguments
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const quick = flag('quick');
if (quick && !value('pages')) { console.error('--quick needs --pages (e.g. --pages student or admin/devices.html)'); process.exit(2); }
const engineArg = quick ? 'chromium' : (value('engine') ?? 'all');
const engines = engineArg === 'all' ? Object.keys(ENGINES) : [engineArg];
const widths = quick ? [375, 1366] : (value('widths')?.split(',').map(Number) ?? ALL_WIDTHS);
const pages = (value('pages')?.split(',') ?? Object.keys(GROUPS)).flatMap((p) => GROUPS[p] ?? [p]);
for (const p of pages) if (!fs.existsSync(path.join(FRONTEND, p))) { console.error(`Unknown page: ${p}`); process.exit(2); }
if (engines.some((e) => !ENGINES[e])) { console.error(`Unknown engine: ${engineArg}`); process.exit(2); }

// ---- localhost-only static server for frontend/ (never backend/)
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const file = path.join(FRONTEND, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(FRONTEND + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---- fake API, in-process only (page.route); the browser clock is frozen to the same instant
const api = createLayoutApi();
const sessions = { admin: api.sessionFor('admin'), instructor: api.sessionFor('instructor'), student: api.sessionFor('student') };

// ---- in-page checks (serialized into the browser)
function pageChecks({ touch, width }) {
  const short = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = !id && typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    const text = (el.textContent || el.getAttribute('aria-label') || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 20);
    return `${el.tagName.toLowerCase()}${id}${cls}${text ? `[${text}]` : ''}`;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[hidden],[aria-hidden="true"]');
  };
  const out = { touch_emulation: [], touch_target: [], input_font_size: [], input_label: [], not_yet_wrap: [], reduced_motion_animations: [], horizontal_scroll: [] };
  // vs the configured width: an isMobile layout viewport can grow to fit wide content
  if (document.documentElement.scrollWidth > width) out.horizontal_scroll.push(`scrollWidth ${document.documentElement.scrollWidth} > ${width}`);
  if (touch && !matchMedia('(pointer: coarse)').matches) out.touch_emulation.push('pointer: coarse does not match');

  document.querySelectorAll('input, select, textarea').forEach((el) => {
    if (el.type === 'hidden' || el.hidden || getComputedStyle(el).display === 'none') return; // not rendered = not exposed, needs no label
    const named = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label') || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
    if (!named) out.input_label.push(short(el));
    if (touch && visible(el) && parseFloat(getComputedStyle(el).fontSize) < 16) out.input_font_size.push(`${short(el)} ${getComputedStyle(el).fontSize}`);
  });

  if (touch) {
    document.querySelectorAll('button, a, select, input, [role=button]').forEach((input) => {
      // a visually hidden .btn-check radio/checkbox is tapped through its label: measure the label (a small label still fails)
      const label = input.matches('input.btn-check') && input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null;
      const el = label || input;
      if (el.type === 'hidden' || !visible(el)) return;
      if (el.tagName === 'A' && el.parentElement.textContent.trim() !== el.textContent.trim()) return; // link inside running text
      const r = el.getBoundingClientRect();
      if (r.width >= 44 && r.height >= 44) return;
      // a larger hit area (e.g. ::after) counts: probe the corners of a 44x44 box around the centre
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r2 = el.getBoundingClientRect();
      const x0 = r2.left + r2.width / 2 - 21;
      const y0 = r2.top + r2.height / 2 - 21;
      const ok = [[x0, y0], [x0 + 42, y0], [x0, y0 + 42], [x0 + 42, y0 + 42]].every(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return hit && (hit === el || el.contains(hit));
      });
      if (!ok) out.touch_target.push(`${short(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    });
  }

  document.querySelectorAll('*').forEach((el) => {
    if (el.children.length === 0 && el.textContent.trim() === 'Not yet' && visible(el)) {
      // count text lines (not the box height: a padded table head is one line, but tall)
      const range = document.createRange();
      range.selectNodeContents(el);
      const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
      if (lines > 1) out.not_yet_wrap.push(`${short(el)} lines=${lines}`);
    }
  });

  document.getAnimations().filter((a) => a.effect && a.effect.getTiming().duration > 1).forEach((a) => {
    const t = a.effect.target;
    out.reduced_motion_animations.push(`${t ? short(t) : '?'} ${a.animationName ?? a.transitionProperty ?? ''}`);
  });
  return out;
}

// ---- run
const results = {}; // check -> Set of items
const record = (check, item) => { (results[check] ??= new Set()).add(item); };
const PAGES_AT_ONCE = 8;

async function runEngine(engineName) {
  const browser = await ENGINES[engineName].launch();
  try {
    const contexts = [];
    const queue = [];
    for (const width of widths) {
      const phone = width <= PHONE_MAX;
      const touch = width <= TOUCH_MAX && engineName !== 'firefox'; // Firefox has no isMobile: no touch checks there
      const context = await browser.newContext({
        viewport: { width, height: phone ? 800 : 900 }, reducedMotion: value('motion') ?? 'reduce', serviceWorkers: 'block',
        ...(touch ? { hasTouch: true, isMobile: true } : {}),
      });
      contexts.push(context);
      await context.clock.setFixedTime(api.now);
      await context.route('**/*', (route) => {
        const requestUrl = route.request().url();
        if (requestUrl.split('?')[0] === CONFIG.API_URL) {
          const body = JSON.parse(route.request().postData() || '{}');
          return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(api.handle(body)) });
        }
        const url = new URL(requestUrl);
        // main loads Bootstrap + icons from jsDelivr and fonts from Google Fonts; any other host is a bug
        if (url.hostname === '127.0.0.1' || CDN_HOSTS.includes(url.hostname) || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
        return route.abort();
      });
      for (const p of pages) queue.push({ context, width, touch, page: p });
    }
    await Promise.all(Array.from({ length: PAGES_AT_ONCE }, async () => {
      while (queue.length) await checkPage(engineName, queue.shift());
    }));
    await Promise.all(contexts.map((c) => c.close()));
  } finally {
    await browser.close();
  }
}

async function checkPage(engineName, { context, width, touch, page: pageKey }) {
  const tag = `${pageKey}@${width}/${engineName}`;
  const page = await context.newPage();
  const role = pageKey.split('/')[0];
  try {
    if (sessions[role]) await page.addInitScript((s) => sessionStorage.setItem('rfid.session', JSON.stringify(s)), sessions[role]);
    page.on('pageerror', (e) => record('console_errors', `${tag} pageerror: ${String(e.message).slice(0, 80)}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) record('console_errors', `${tag} ${m.text().slice(0, 80)}`); });
    await page.goto(`${BASE}/${pageKey}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const found = await page.evaluate(pageChecks, { touch, width });
    for (const [check, items] of Object.entries(found)) items.forEach((d) => record(check, `${tag} ${d}`));
    const shot = path.join(root, 'layout-shots', engineName, `${pageKey.replace(/\//g, '-').replace('.html', '')}@${width}.png`);
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    await page.screenshot({ path: shot, fullPage: true });
  } catch (error) {
    record('load_errors', `${tag} ${String(error.message).split('\n')[0].slice(0, 80)}`);
  } finally {
    await page.close();
  }
}

await Promise.all(engines.map(runEngine));
server.close();

// ---- summary
const CHECKS = ['touch_emulation', 'horizontal_scroll', 'console_errors', 'touch_target', 'input_font_size', 'input_label', 'reduced_motion_animations', 'not_yet_wrap', 'load_errors'];
const summary = {};
for (const c of CHECKS) { const items = [...(results[c] ?? [])].sort(); summary[c] = { count: items.length, items }; }
fs.mkdirSync(path.join(root, 'layout-shots'), { recursive: true });
fs.writeFileSync(path.join(root, 'layout-shots/summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(CHECKS.map((c) => `${c}: ${summary[c].count}`).join('\n'));

let failed = Object.values(summary).some((s) => s.count > 0);
const writeTo = value('write-baseline');
if (writeTo) {
  fs.writeFileSync(path.resolve(writeTo), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`baseline written: ${writeTo}`);
  failed = false;
}
const compareTo = value('compare');
if (compareTo) {
  // Only baseline items inside this run's scope (pages x widths x engines) are compared.
  const base = JSON.parse(fs.readFileSync(path.resolve(compareTo), 'utf8'));
  const inScope = (item) => {
    const m = /^(\S+)@(\d+)\/(\w+)/.exec(item);
    return m && pages.includes(m[1]) && widths.includes(Number(m[2])) && engines.includes(m[3]);
  };
  failed = false;
  for (const c of CHECKS) {
    const was = (base[c]?.items ?? []).filter(inScope).length;
    if (summary[c].count > was) { failed = true; console.log(`WORSE ${c}: ${summary[c].count} > baseline ${was}`); }
  }
  console.log(failed ? 'compare: FAILED' : 'compare: ok');
}
console.log(`elapsed: ${((performance.now() - started) / 1000).toFixed(1)} s`);
process.exit(failed ? 1 : 0);
