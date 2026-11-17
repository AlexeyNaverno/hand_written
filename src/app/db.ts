/** The glyph library lives in the browser's IndexedDB: PNG bytes plus metadata per letter variant. */
import type { StoredGlyph } from '../worker/protocol';

const NAME = 'handwritten';
const STORE = 'glyphs';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const r = fn(t.objectStore(STORE));
        t.oncomplete = () => { db.close(); resolve(r ? r.result : undefined); };
        t.onerror = () => { db.close(); reject(t.error); };
        t.onabort = () => { db.close(); reject(t.error); };
      }),
  );
}

export const dbAll = () => tx<StoredGlyph[]>('readonly', (s) => s.getAll()).then((v) => v ?? []);
export const dbPutMany = (items: StoredGlyph[]) => tx('readwrite', (s) => { for (const g of items) s.put(g); });
export const dbDelete = (ids: string[]) => tx('readwrite', (s) => { for (const id of ids) s.delete(id); });
export const dbClear = () => tx('readwrite', (s) => { s.clear(); });

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
