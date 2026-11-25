/**
 * IndexedDB key/value access. HiROM Map keeps its own database and reads the other HiROM Studio
 * apps' autosaves directly (same site, same browser), which is what makes asset links "live".
 */
export const MAP_DB = 'hirom-map';
export const PIXEL_DB = 'hirom-pixel';
export const PIXEL_AUTOSAVE_KEY = 'autosave';
export const SOUND_DB = 'snes-studio';
const STORE = 'kv';

function open(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(name: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open(name);
  try {
    if (!db.objectStoreNames.contains(STORE)) return undefined as T;
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** True if another app has created its database (so reading it won't create an empty one). */
export async function dbExists(name: string): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  if (!indexedDB.databases) return true;
  try {
    return (await indexedDB.databases()).some((d) => d.name === name);
  } catch {
    return true;
  }
}

export const kvGet = <T>(db: string, key: string) => run<T | undefined>(db, 'readonly', (s) => s.get(key));
export const kvSet = (db: string, key: string, value: unknown) => run(db, 'readwrite', (s) => s.put(value, key));
export const kvDelete = (db: string, key: string) => run(db, 'readwrite', (s) => s.delete(key));
export const kvKeys = (db: string) => run<IDBValidKey[]>(db, 'readonly', (s) => s.getAllKeys());

/** Tell the other HiROM Studio apps (in other tabs) that something was saved. */
export const SUITE_CHANNEL = 'hirom-studio';
export function announce(app: 'map', type = 'saved'): void {
  try {
    const ch = new BroadcastChannel(SUITE_CHANNEL);
    ch.postMessage({ app, type });
    ch.close();
  } catch {
    // BroadcastChannel unavailable: other tabs refresh when focused instead.
  }
}

/** Calls back when HiROM Pixel or HiROM Sound saves in another tab, or when this tab regains focus. */
export function onSuiteSaved(cb: (app: 'pixel' | 'sound' | 'focus') => void): () => void {
  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel(SUITE_CHANNEL);
    ch.onmessage = (e) => {
      const app = e.data?.app;
      if (app === 'pixel' || app === 'sound') cb(app);
    };
  } catch {
    ch = null;
  }
  const onFocus = () => cb('focus');
  window.addEventListener('focus', onFocus);
  return () => {
    ch?.close();
    window.removeEventListener('focus', onFocus);
  };
}
