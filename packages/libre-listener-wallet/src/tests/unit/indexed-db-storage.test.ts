import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import { IndexedDBStorageProvider } from "../../indexed-db-storage";

describe("IndexedDBStorageProvider", () => {
  it("round-trips set/get/remove/clear", async () => {
    const s = new IndexedDBStorageProvider("test-roundtrip");
    await s.setItem("a", "1");
    expect(await s.getItem("a")).toBe("1");
    await s.removeItem("a");
    expect(await s.getItem("a")).toBeNull();
    await s.setItem("b", "2");
    await s.clear();
    expect(await s.getItem("b")).toBeNull();
  });

  it("keys() lists every stored key (incl. untracked preimage_*)", async () => {
    const s = new IndexedDBStorageProvider("test-keys");
    await s.setItem("ldk_seed", "aa");
    await s.setItem("preimage_x", "bb");
    await s.setItem("monitors/y", "cc");
    expect((await s.keys()).sort()).toEqual(["ldk_seed", "monitors/y", "preimage_x"]);
  });

  it("isolates two different DB names", async () => {
    const reg = new IndexedDBStorageProvider("libre-wallet-regtest");
    const main = new IndexedDBStorageProvider("libre-wallet-mainnet");
    await reg.setItem("ldk_seed", "regtestseed");
    expect(await main.getItem("ldk_seed")).toBeNull();
    expect(await reg.getItem("ldk_seed")).toBe("regtestseed");
  });

  // A write must only be reported as successful once the transaction has
  // durably committed. The IndexedDB request fires `success` *before* commit,
  // so a write that succeeds-then-aborts (commit failure / rollback) must
  // surface as a rejection — never a false success. Resolving on the request
  // instead of the transaction is the bug that let Mutiny persist (and later
  // act on) channel state it had not actually committed.
  it("setItem rejects — does not falsely succeed — when the tx aborts after the write succeeds", async () => {
    const s = new IndexedDBStorageProvider("test-commit-abort");
    await s.setItem("warm", "1"); // open the connection before spying

    const origPut = IDBObjectStore.prototype.put;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (this: IDBObjectStore, value: any, key?: any) {
        const req = origPut.call(this, value, key);
        // The request reports success while the tx is still open; abort here to
        // simulate a commit-time rollback before the data is durable.
        req.addEventListener("success", () => req.transaction!.abort());
        return req;
      });

    try {
      await expect(s.setItem("k", "v")).rejects.toBeTruthy();
    } finally {
      spy.mockRestore();
    }

    // The aborted write must not have persisted.
    expect(await s.getItem("k")).toBeNull();
  });

  // A mobile browser force-closes a backgrounded tab's IDB connection on freeze/discard. The cached
  // handle then throws InvalidStateError ("the database connection is closing") on every subsequent
  // transaction — which wedged all persistence until a full page reload (the live "Failed to persist
  // channel_manager: … connection is closing" spam after a resume). The provider must transparently
  // reopen and keep working.
  it("reopens transparently after the cached connection is force-closed (frozen-tab recovery)", async () => {
    const s = new IndexedDBStorageProvider("test-reopen");
    await s.setItem("k", "v"); // opens + caches the connection
    // Simulate the browser tearing the connection down while the tab was frozen.
    (s as unknown as { db: IDBDatabase }).db.close();
    // Reads and writes must recover rather than reject forever.
    expect(await s.getItem("k")).toBe("v");
    await s.setItem("k", "v2");
    expect(await s.getItem("k")).toBe("v2");
    // keys() shares the same recovery path.
    (s as unknown as { db: IDBDatabase }).db.close();
    expect(await s.keys()).toEqual(["k"]);
  });

  // A read failure (DB open / transaction error) must REJECT, not resolve null.
  // Flattening it to null lets start() mistake a transiently-broken store for an
  // empty one and overwrite a funded wallet's seed. Absence still returns null.
  it("getItem rejects on a read error — it does not mask it as absent null", async () => {
    const s = new IndexedDBStorageProvider("test-read-error");
    await s.setItem("warm", "1"); // open the connection before spying

    const spy = vi
      .spyOn(IDBDatabase.prototype, "transaction")
      .mockImplementation(() => {
        throw new DOMException("simulated store failure", "InvalidStateError");
      });

    try {
      await expect(s.getItem("warm")).rejects.toBeTruthy();
    } finally {
      spy.mockRestore();
    }

    // Absence still resolves to null (not an error) once storage recovers.
    expect(await s.getItem("does-not-exist")).toBeNull();
  });
});
