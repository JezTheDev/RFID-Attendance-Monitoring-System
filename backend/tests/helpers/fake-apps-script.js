// A small fake of the Apps Script services (in-memory spreadsheet) that runs the
// REAL Server.gs + Bundle.gs + SeedData.gs in a Node vm. Includes a fake of the
// Sheets advanced service (values.batchGet, spreadsheets.get, spreadsheets.batchUpdate)
// that counts what each request reads and writes (`stats`).
// Run `node tools/build_apps_script.mjs` first.
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';

const dir = new URL('../../apps-script/', import.meta.url);

export const SEED = 'Seed2026x'; // FAKE TEST_SEED_PASSWORD
export const PROPS = Object.freeze({ PASSWORD_PEPPER: 'vm-test-pepper', TEST_SEED_PASSWORD: SEED });

let nextSheetId = 100;

function fakeSheet(name) {
  const cells = [];
  const sheet = {
    cells,
    sheetId: nextSheetId++,
    rowCount: 1000,
    columnCount: 26,
    getName: () => name,
    getLastRow: () => { for (let r = cells.length; r > 0; r -= 1) if ((cells[r - 1] || []).some((v) => v !== '' && v !== undefined)) return r; return 0; },
    getLastColumn: () => cells.reduce((max, row) => { for (let c = row.length; c > max; c -= 1) if (row[c - 1] !== '' && row[c - 1] !== undefined) return c; return max; }, 0),
    getMaxRows: () => Math.max(cells.length, sheet.rowCount),
    clear: () => { cells.length = 0; },
    setFrozenRows: () => {}, setTabColor: () => {},
    deleteColumn: (col) => cells.forEach((row) => row.splice(col - 1, 1)),
    getDataRange: () => sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), Math.max(sheet.getLastColumn(), 1)),
    getRange(row, col, numRows = 1, numCols = 1) {
      const range = {
        setNumberFormat: () => range, setFontWeight: () => range, setBackground: () => range, setNote: () => range, setFormula: () => range,
        setValues(values) {
          values.forEach((vals, i) => {
            const r = row - 1 + i;
            while (cells.length <= r) cells.push([]);
            vals.forEach((v, j) => { cells[r][col - 1 + j] = String(v); });
          });
          sheet.onWrite?.(values.length);
          return range;
        },
        clearContent() {
          for (let i = 0; i < numRows; i += 1) for (let j = 0; j < numCols; j += 1) if (cells[row - 1 + i]) cells[row - 1 + i][col - 1 + j] = '';
          return range;
        },
        getDisplayValues: () => Array.from({ length: numRows }, (_, i) => Array.from({ length: numCols }, (_, j) => {
          const v = (cells[row - 1 + i] || [])[col - 1 + j];
          return v === undefined ? '' : v;
        })),
      };
      return range;
    },
  };
  return sheet;
}

// Like the real API: trailing empty cells and rows are left out.
function trimRows(rows) {
  const out = rows.map((r) => {
    const row = r.map((v) => (v === undefined ? '' : v));
    while (row.length && row[row.length - 1] === '') row.pop();
    return row;
  });
  while (out.length && out[out.length - 1].length === 0) out.pop();
  return out;
}

function fakeSheetsApi(ss, sheets, stats) {
  const byId = (id) => {
    const sheet = sheets.find((s) => s.sheetId === id);
    if (!sheet) throw new Error(`No grid with id: ${id}`);
    return sheet;
  };
  const cellText = (cell) => (cell && cell.userEnteredValue ? String(cell.userEnteredValue.stringValue ?? '') : '');
  return {
    Spreadsheets: {
      Values: {
        batchGet(id, { ranges }) {
          return {
            valueRanges: ranges.map((range) => {
              const match = /^'((?:[^']|'')+)'(?:!(\d+):(\d+))?$/.exec(range);
              if (!match) throw new Error(`Unable to parse range: ${range}`);
              const name = match[1].replace(/''/g, "'");
              const sheet = ss.getSheetByName(name);
              if (!sheet) throw new Error(`Unable to parse range: ${range}`);
              let values;
              if (match[2]) {
                const from = Number(match[2]);
                const to = Number(match[3]);
                values = trimRows(sheet.cells.slice(from - 1, to));
                stats.tabsRead.push(`${name} rows ${from}-${to}`);
              } else {
                values = trimRows(sheet.cells);
                stats.tabsRead.push(name);
              }
              stats.rowsRead += values.length;
              return values.length ? { range, values } : { range };
            }),
          };
        },
      },
      get() {
        return {
          sheets: sheets.map((s) => ({
            properties: { sheetId: s.sheetId, title: s.getName(), gridProperties: { rowCount: s.getMaxRows(), columnCount: s.columnCount } },
          })),
        };
      },
      // All-or-nothing like the real API: every request is checked first
      // (sizes simulated in order), then applied in order.
      batchUpdate(resource) {
        stats.batchUpdates += 1;
        if (stats.failNext) {
          stats.failNext = false;
          throw new Error('Simulated Sheets API failure');
        }
        const requests = resource.requests || [];
        const size = new Map(sheets.map((s) => [s.sheetId, { rows: s.getMaxRows(), cols: s.columnCount, last: s.getLastRow() }]));
        requests.forEach((req) => {
          if (req.appendDimension) {
            const g = size.get(byId(req.appendDimension.sheetId).sheetId);
            if (req.appendDimension.dimension === 'ROWS') g.rows += req.appendDimension.length;
            else g.cols += req.appendDimension.length;
          } else if (req.updateCells) {
            const { start, rows } = req.updateCells;
            const g = size.get(byId(start.sheetId).sheetId);
            const width = Math.max(0, ...rows.map((r) => (r.values || []).length));
            if (start.rowIndex + rows.length > g.rows || start.columnIndex + width > g.cols) throw new Error('Range exceeds grid limits');
            g.last = Math.max(g.last, start.rowIndex + rows.length);
          } else if (req.appendCells) {
            const { sheetId, rows } = req.appendCells;
            const g = size.get(byId(sheetId).sheetId);
            // Stricter than the real API (which inserts rows itself): proves Server.gs makes room first.
            if (g.last + rows.length > g.rows) throw new Error('Range exceeds grid limits');
            g.last += rows.length;
          } else {
            throw new Error(`Unsupported request: ${Object.keys(req).join(',')}`);
          }
        });
        requests.forEach((req) => {
          if (req.appendDimension) {
            const sheet = byId(req.appendDimension.sheetId);
            if (req.appendDimension.dimension === 'ROWS') sheet.rowCount = sheet.getMaxRows() + req.appendDimension.length;
            else sheet.columnCount += req.appendDimension.length;
          } else if (req.updateCells) {
            const { start, rows } = req.updateCells;
            const sheet = byId(start.sheetId);
            rows.forEach((r, i) => {
              const at = start.rowIndex + i;
              while (sheet.cells.length <= at) sheet.cells.push([]);
              (r.values || []).forEach((cell, j) => { sheet.cells[at][start.columnIndex + j] = cellText(cell); });
            });
            stats.rowsWritten += rows.length;
          } else {
            const { sheetId, rows } = req.appendCells;
            const sheet = byId(sheetId);
            let at = sheet.getLastRow();
            rows.forEach((r) => {
              while (sheet.cells.length <= at) sheet.cells.push([]);
              sheet.cells[at] = (r.values || []).map(cellText);
              at += 1;
            });
            stats.rowsWritten += rows.length;
          }
        });
        return { replies: requests.map(() => ({})) };
      },
    },
  };
}

export function makeServer(props = PROPS, { sheetsApi = true } = {}) {
  const source = ['SeedData.gs', 'Bundle.gs', 'Server.gs'].map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
  const locks = { taken: 0, released: 0, available: true };
  const stats = { tabsRead: [], rowsRead: 0, rowsWritten: 0, batchUpdates: 0, failNext: false };
  const resetStats = () => Object.assign(stats, { tabsRead: [], rowsRead: 0, rowsWritten: 0, batchUpdates: 0, failNext: false });
  const sheets = [];
  const addSheet = (n) => {
    const s = fakeSheet(n);
    s.onWrite = (rows) => { stats.rowsWritten += rows; };
    sheets.push(s);
    return s;
  };
  addSheet('Sheet1');
  const ss = {
    getId: () => 'fake', getSheets: () => sheets.slice(),
    getSheetByName: (n) => sheets.find((s) => s.getName() === n) || null,
    insertSheet: (n) => addSheet(n),
    deleteSheet: (s) => sheets.splice(sheets.indexOf(s), 1),
  };
  const toSigned = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
  const logs = [];
  const fmt = (date, pattern) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).map((x) => [x.type, x.value]));
    return pattern.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
  };
  const globals = {
    console: { log: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (n) => props[n] ?? null, getProperties: () => ({ ...props }) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => { locks.taken += 1; return locks.available; }, releaseLock: () => { locks.released += 1; } }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text) => ({ setMimeType: () => ({ text }) }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      computeDigest: (alg, bytes) => {
        bytes.forEach((b) => { if (b < -128 || b > 127) throw new Error('not a Java byte'); });
        return toSigned(createHash('sha256').update(Buffer.from(bytes.map((b) => b & 0xff))).digest());
      },
      newBlob: (text) => ({ getBytes: () => toSigned(Buffer.from(String(text), 'utf8')) }),
      getUuid: () => randomUUID(),
      formatDate: fmt,
    },
  };
  if (sheetsApi) globals.Sheets = fakeSheetsApi(ss, sheets, stats);
  const context = vm.createContext(globals);
  vm.runInContext(source, context);
  vm.runInContext('setupViews = function () {};', context); // formulas are not under test
  const post = (body) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  const tab = (name) => {
    const [head, ...rows] = ss.getSheetByName(name).cells;
    return rows.filter((r) => r.some((v) => v !== '' && v !== undefined)).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
  };
  const usersTab = () => tab('Users');
  return { context, ss, post, logs, usersTab, tab, locks, stats, resetStats };
}
