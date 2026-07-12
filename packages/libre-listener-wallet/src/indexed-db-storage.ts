import { SecureStorageProvider } from "./index";

// The browser can force-close our cached IDBDatabase handle out from under us — most commonly when a
// mobile browser (Brave/Chrome on Android) freezes or discards a backgrounded tab. The stale handle
// then throws InvalidStateError ("The database connection is closing") on EVERY subsequent
// transaction, wedging all persistence until a full page reload (seen live: a resumed PWA spammed
// "Failed to persist channel_manager: … database connection is closing" until reload). We recover by
// dropping the dead handle and reopening once. `transaction()` throws InvalidStateError ONLY when the
// connection is closing/closed (our store always exists), so this is a precise signal — and a retry
// of an idempotent put/delete/get is safe. Crucially, a SECOND failure still rejects, so a genuine
// persistent fault surfaces (StorageCache flips to degraded → LDK stops advancing, and start() never
// mistakes a broken read for an absent seed): we heal a transient close, never mask a real fault.
function isConnectionClosed(e: unknown): boolean {
  return e instanceof DOMException && e.name === "InvalidStateError";
}

export class IndexedDBStorageProvider implements SecureStorageProvider {
  private dbName: string;
  private storeName: string;
  private db: IDBDatabase | null = null;
  private openPromise: Promise<IDBDatabase> | null = null;

  constructor(dbName = "libre-wallet", storeName = "settings") {
    this.dbName = dbName;
    this.storeName = storeName;
  }

  private getDB(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);
    // Coalesce concurrent opens (a resume burst re-issues many persists at once) onto one request so
    // we don't spawn a fresh connection per in-flight op.
    if (!this.openPromise) {
      this.openPromise = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === "undefined") {
          reject(new Error("indexedDB is not defined in this environment"));
          return;
        }
        const request = indexedDB.open(this.dbName, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore(this.storeName);
        };
        request.onsuccess = () => {
          const db = request.result;
          // Drop the cache the instant the browser force-closes this connection (tab freeze/discard)
          // so the next call reopens rather than throwing on a dead handle. The transaction-level
          // retry below is the backstop for when `close` doesn't fire before the next op.
          db.onclose = () => {
            if (this.db === db) this.db = null;
          };
          resolve(db);
        };
        request.onerror = () => reject(request.error);
      }).then(
        (db) => {
          this.db = db;
          this.openPromise = null;
          return db;
        },
        (e) => {
          this.openPromise = null;
          throw e;
        },
      );
    }
    return this.openPromise;
  }

  // Run one IndexedDB operation, transparently dropping + reopening the connection once if the cached
  // handle was force-closed while the tab was frozen. See isConnectionClosed for the fund-safety
  // reasoning (a second failure still propagates).
  private async withReopen<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (e) {
      if (isConnectionClosed(e)) {
        this.db = null;
        return op();
      }
      throw e;
    }
  }

  getItem(key: string): Promise<string | null> {
    // Only genuine key-absence resolves to null. A DB-open/transaction failure
    // MUST reject, never be flattened to null: a caller like the wallet's
    // start() reads a null `ldk_seed` as "new wallet" and would generate + write
    // a fresh seed, silently overwriting a funded wallet whose storage was only
    // transiently unavailable (quota pressure, blocked upgrade, corruption
    // recovery). Swallowing the error here is also a no-silent-catch violation.
    return this.withReopen(
      () =>
        this.getDB().then(
          (db) =>
            new Promise<string | null>((resolve, reject) => {
              const tx = db.transaction(this.storeName, "readonly");
              const store = tx.objectStore(this.storeName);
              const req = store.get(key);
              req.onsuccess = () => resolve(req.result !== undefined ? req.result : null);
              req.onerror = () => reject(req.error);
            }),
        ),
    );
  }

  // Resolve a write only once its transaction has durably COMMITTED, not when
  // the request fires `success` (which happens before commit). A write that
  // succeeds but whose transaction later aborts/fails would otherwise be
  // reported as persisted while being silently rolled back — the storage
  // inconsistency that lets a Lightning node act on channel state it never
  // committed. `onComplete`/`onerror`/`onabort` live on the transaction, so the
  // promise tracks the commit boundary; the request handler only captures a
  // more specific error for the rejection.
  private commitWrite(
    mutate: (store: IDBObjectStore) => IDBRequest,
  ): Promise<void> {
    return this.withReopen(
      () =>
        this.getDB().then(
          (db) =>
            new Promise<void>((resolve, reject) => {
              const tx = db.transaction(this.storeName, "readwrite");
              const req = mutate(tx.objectStore(this.storeName));
              let reqError: DOMException | null = null;
              req.onerror = () => {
                reqError = req.error;
              };
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(reqError ?? tx.error);
              tx.onabort = () =>
                reject(
                  reqError ?? tx.error ?? new Error("IndexedDB transaction aborted"),
                );
            }),
        ),
    );
  }

  async setItem(key: string, value: string): Promise<void> {
    return this.commitWrite((store) => store.put(value, key));
  }

  async removeItem(key: string): Promise<void> {
    return this.commitWrite((store) => store.delete(key));
  }

  // Erase all keys in the store — used to start a fresh wallet (clears seed,
  // channel manager, channel monitors, and the LDK key index).
  async clear(): Promise<void> {
    return this.commitWrite((store) => store.clear());
  }

  // Enumerate every key in the store — used by app-layer migration to copy a full
  // legacy DB into a network-scoped one (including preimage_* keys not tracked in
  // ldk_keys_index).
  async keys(): Promise<string[]> {
    return this.withReopen(
      () =>
        this.getDB().then(
          (db) =>
            new Promise<string[]>((resolve, reject) => {
              const tx = db.transaction(this.storeName, "readonly");
              const req = tx.objectStore(this.storeName).getAllKeys();
              req.onsuccess = () => resolve((req.result as IDBValidKey[]).map((k) => String(k)));
              req.onerror = () => reject(req.error);
            }),
        ),
    );
  }
}
