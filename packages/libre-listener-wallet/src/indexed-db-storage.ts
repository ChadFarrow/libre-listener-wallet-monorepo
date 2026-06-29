import { SecureStorageProvider } from "./index";

export class IndexedDBStorageProvider implements SecureStorageProvider {
  private dbName: string;
  private storeName: string;
  private db: IDBDatabase | null = null;

  constructor(dbName = "libre-wallet", storeName = "settings") {
    this.dbName = dbName;
    this.storeName = storeName;
  }

  private async getDB(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("indexedDB is not defined in this environment"));
        return;
      }
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(this.storeName);
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getItem(key: string): Promise<string | null> {
    try {
      const db = await this.getDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.storeName, "readonly");
        const store = tx.objectStore(this.storeName);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result !== undefined ? req.result : null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      return null;
    }
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
    return this.getDB().then(
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
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const req = tx.objectStore(this.storeName).getAllKeys();
      req.onsuccess = () => resolve((req.result as IDBValidKey[]).map((k) => String(k)));
      req.onerror = () => reject(req.error);
    });
  }
}
