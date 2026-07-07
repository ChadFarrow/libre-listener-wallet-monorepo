import { describe, it, expect, beforeAll } from "vitest";
import { initializeWasmFromBinary } from "lightningdevkit";
import { StorageCache } from "../../storage-cache";
import type { SecureStorageProvider } from "../../index";
import * as fs from "fs";
import * as path from "path";

function loadWasmBinary(): Uint8Array {
  const paths = [
    path.resolve(__dirname, "../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(__dirname, "../../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(__dirname, "../../../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(__dirname, "../../../../../node_modules/.pnpm/node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "../../node_modules/lightningdevkit/liblightningjs.wasm"),
  ];

  for (const p of paths) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p);
    }
  }
  throw new Error("Could not find liblightningjs.wasm");
}

// A storage whose setItem resolution is controllable, to exercise the durability barrier.
function deferredStorage() {
  const deferreds: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  const storage: SecureStorageProvider = {
    getItem: async () => null,
    setItem: () =>
      new Promise<void>((resolve, reject) => deferreds.push({ resolve, reject })),
    removeItem: () =>
      new Promise<void>((resolve, reject) => deferreds.push({ resolve, reject })),
  };
  return { storage, deferreds };
}

describe("StorageCache.flush", () => {
  beforeAll(async () => {
    const bin = loadWasmBinary();
    await initializeWasmFromBinary(bin);
  });
  it("resolves immediately when nothing is pending", async () => {
    const { storage } = deferredStorage();
    const cache = new StorageCache(storage);
    await expect(cache.flush()).resolves.toBeUndefined();
  });

  it("reload() picks up keys written to storage out-of-band; load() (idempotent) does not", async () => {
    // Simulate the VSS re-hydrate: importState writes channel_manager + monitor keys + a new
    // ldk_keys_index straight to storage, bypassing the already-loaded cache.
    const mem: Record<string, string> = { ldk_keys_index: JSON.stringify([]) };
    const storage = {
      getItem: async (k: string) => (k in mem ? mem[k] : null),
      setItem: async (k: string, v: string) => { mem[k] = v; },
      removeItem: async (k: string) => { delete mem[k]; },
    };
    const cache = new StorageCache(storage as any);
    await cache.load(); // initial load: index is empty

    // importState-style out-of-band write of a monitor key ("monitors/abc_0") + updated index.
    mem["monitors/abc_0"] = "01020304"; // hex value the cache decodes to bytes
    mem["ldk_keys_index"] = JSON.stringify(["monitors/abc_0"]);

    await cache.load(); // no-op (already loaded) — must NOT see the new key
    expect(cache.read("monitors", "", "abc_0").is_ok()).toBeFalsy();

    await cache.reload(); // forces a re-read — now serves it
    const r = cache.read("monitors", "", "abc_0");
    expect(r.is_ok()).toBeTruthy();
    expect(Array.from((r as any).res as Uint8Array)).toEqual([1, 2, 3, 4]);
  });

  it("waits for pending writes, then resolves", async () => {
    const { storage, deferreds } = deferredStorage();
    const cache = new StorageCache(storage);
    cache.write("monitors", "", "a", new Uint8Array([1])); // fires setItem(s), still pending
    let flushed = false;
    const p = cache.flush().then(() => { flushed = true; });
    await Promise.resolve();
    expect(flushed).toBe(false);            // still pending
    deferreds.forEach((d) => d.resolve());  // durable commit lands
    await p;
    expect(flushed).toBe(true);
  });

  it("rejects when a pending write failed", async () => {
    const { storage, deferreds } = deferredStorage();
    const cache = new StorageCache(storage);
    cache.write("monitors", "", "a", new Uint8Array([1]));
    const p = cache.flush();
    deferreds.forEach((d) => d.reject(new Error("commit failed")));
    await expect(p).rejects.toThrow(/flush/i);
  });

  // Regression: a degraded cache refuses subsequent writes SYNCHRONOUSLY, before they
  // ever reach `pending` — so flush() must consult the health flag directly, not just
  // await whatever happens to be in `pending`. Otherwise a refused monitor write would
  // be reported as durable (Promise.allSettled([]) resolves) and LDK would advance on
  // state that was never persisted.
  it("rejects flush once persistence has degraded, even though the refused write never entered pending", async () => {
    const { storage, deferreds } = deferredStorage();
    const cache = new StorageCache(storage);

    // First write's async persist will fail, flipping the cache to degraded.
    cache.write("monitors", "", "a", new Uint8Array([1]));
    deferreds.forEach((d) => d.reject(new Error("commit failed")));
    await new Promise((r) => setTimeout(r, 0)); // let the rejection settle + onPersistError run
    expect(cache.isPersistenceHealthy()).toBe(false);

    // A second write is now refused SYNCHRONOUSLY — no new setItem call, nothing added to pending.
    const deferredCountBefore = deferreds.length;
    const w2 = cache.write("monitors", "", "b", new Uint8Array([2]));
    expect(w2.is_ok()).toBeFalsy();
    expect(deferreds.length).toBe(deferredCountBefore); // confirms it never reached storage/pending

    await expect(cache.flush()).rejects.toThrow(/degraded/i);
  });

  // Even with nothing whatsoever in `pending` (no writes issued at all after degrading),
  // flush() must still reject — durability can't be claimed for a cache that is actively
  // refusing writes.
  it("rejects flush when degraded, even with an empty pending set", async () => {
    const { storage, deferreds } = deferredStorage();
    const cache = new StorageCache(storage);

    cache.write("monitors", "", "a", new Uint8Array([1]));
    deferreds.forEach((d) => d.reject(new Error("commit failed")));
    await new Promise((r) => setTimeout(r, 0));
    expect(cache.isPersistenceHealthy()).toBe(false);

    // Nothing is pending: the earlier write's promise already settled and was removed
    // from `pending` by track()'s cleanup handler.
    await expect(cache.flush()).rejects.toThrow(/degraded/i);
  });
});
