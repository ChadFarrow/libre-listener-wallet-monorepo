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
});
