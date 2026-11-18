import { DEMO_DATA } from './demo-data.js';

const STORE_KEY = 'rfid.demo.db';

let cache = null;

export function loadDb() {
  if (cache) return cache;
  try {
    const saved = sessionStorage.getItem(STORE_KEY);
    cache = saved ? JSON.parse(saved) : structuredClone(DEMO_DATA);
  } catch {
    cache = structuredClone(DEMO_DATA);
  }
  return cache;
}

export function saveDb() {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(cache));
    return true;
  } catch {
    return false;
  }
}

export function resetDb() {
  cache = structuredClone(DEMO_DATA);
  try {
    sessionStorage.removeItem(STORE_KEY);
  } catch {
    /* storage unavailable: the in-memory copy is already reset */
  }
}
