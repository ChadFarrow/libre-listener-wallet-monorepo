// IndexedDB persistence for the diagnostic ring buffer. ITS OWN database
// ("libre-diagnostics") — deliberately NOT one of the wallet DBs, so it has zero
// storage-contract surface, never appears in wallet keys() scans, and is disposable.
// Exact batching/cap policy lives in core/diag-log.ts; this enforces the cap
// approximately on write (good enough for a debug artifact).
import type { DiagEntry } from "./diag-log";

export const DIAG_DB_NAME = "libre-diagnostics";
const STORE = "entries";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DIAG_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("diag db open failed"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("diag tx failed"));
    tx.onabort = () => reject(tx.error ?? new Error("diag tx aborted"));
  });
}

export class DiagStore {
  /** Append a batch; if the store exceeds `cap`, delete the oldest overflow in the same tx. */
  async append(entries: DiagEntry[], cap: number): Promise<void> {
    if (entries.length === 0) return;
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const entry of entries) store.add(entry);
      const countReq = store.count();
      countReq.onsuccess = () => {
        const overflow = countReq.result - cap;
        if (overflow <= 0) return;
        // Keys are autoIncrement → ascending = oldest first; delete the first `overflow`.
        let left = overflow;
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor || left <= 0) return;
          cursor.delete();
          left--;
          cursor.continue();
        };
      };
      await done(tx);
    } finally {
      db.close();
    }
  }

  async readAll(): Promise<DiagEntry[]> {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      await done(tx);
      return (req.result as DiagEntry[]) ?? [];
    } finally {
      db.close();
    }
  }

  async clear(): Promise<void> {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      await done(tx);
    } finally {
      db.close();
    }
  }

  async count(): Promise<number> {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).count();
      await done(tx);
      return req.result;
    } finally {
      db.close();
    }
  }
}

/** Drop the whole diagnostics DB (delete-all flow; also used to reset between tests). */
export function deleteDiagDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DIAG_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve(); // disposable data — never block delete-all on it
    req.onblocked = () => resolve();
  });
}
