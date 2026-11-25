/** Tiny IndexedDB key/value wrapper used for offline autosave. */
const DB_NAME = 'hirom-pixel';
/** Pre-rename database, read once so earlier autosaves carry over. */
const LEGACY_DB_NAME = 'snes-pixel-studio';
const STORE = 'kv';

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(name: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb(name);
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export const idbSet = (key: string, value: unknown) => run(DB_NAME, 'readwrite', (s) => s.put(value, key));

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const v = await run<T | undefined>(DB_NAME, 'readonly', (s) => s.get(key));
  if (v !== undefined) return v;
  try {
    return await run<T | undefined>(LEGACY_DB_NAME, 'readonly', (s) => s.get(key));
  } catch {
    return undefined;
  }
}
