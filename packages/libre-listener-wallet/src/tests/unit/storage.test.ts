import { describe, it, expect, beforeAll } from "vitest";
import { initializeWasmFromBinary, KVStore } from "lightningdevkit";
import { StorageCache } from "../../storage-cache";
import { SecureStorageProvider } from "../../index";
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

describe("StorageCache Unit Tests", () => {
  beforeAll(async () => {
    const bin = loadWasmBinary();
    await initializeWasmFromBinary(bin);
  });

  it("should initialize empty and write/read/list/remove keys correctly", async () => {
    const db = new Map<string, string>();
    const mockStorage: SecureStorageProvider = {
      getItem: async (key) => db.get(key) || null,
      setItem: async (key, val) => {
        db.set(key, val);
      },
      removeItem: async (key) => {
        db.delete(key);
      },
    };

    const cache = new StorageCache(mockStorage);
    await cache.load();

    const kvStore = KVStore.new_impl(cache);

    // 1. Read non-existent key
    const readNone = kvStore.read("ns", "", "testkey");
    expect(readNone.is_ok()).toBeFalsy();

    // 2. Write key
    const data = new Uint8Array([1, 2, 3, 4]);
    const writeRes = kvStore.write("ns", "sub", "testkey", data);
    expect(writeRes.is_ok()).toBeTruthy();

    // 3. Read back
    const readBack = kvStore.read("ns", "sub", "testkey");
    expect(readBack.is_ok()).toBeTruthy();
    expect((readBack as any).res).toEqual(data);

    // 4. List keys in namespaces
    const listRes = kvStore.list("ns", "sub");
    expect(listRes.is_ok()).toBeTruthy();
    expect((listRes as any).res).toEqual(["testkey"]);

    // List with mismatched namespace
    const listEmpty = kvStore.list("ns", "other");
    expect((listEmpty as any).res).toEqual([]);

    // 5. Remove key
    const removeRes = kvStore.remove("ns", "sub", "testkey", false);
    expect(removeRes.is_ok()).toBeTruthy();

    // Read again
    const readAfterRemove = kvStore.read("ns", "sub", "testkey");
    expect(readAfterRemove.is_ok()).toBeFalsy();

    // List after remove
    const listAfterRemove = kvStore.list("ns", "sub");
    expect((listAfterRemove as any).res).toEqual([]);
  });

  it("degrades and refuses further writes once a background persist fails", async () => {
    let failWrites = false;
    const db = new Map<string, string>();
    const mockStorage: SecureStorageProvider = {
      getItem: async (key) => db.get(key) || null,
      setItem: async (key, val) => {
        if (failWrites) throw new Error("simulated quota exceeded");
        db.set(key, val);
      },
      removeItem: async (key) => {
        db.delete(key);
      },
    };

    const cache = new StorageCache(mockStorage);
    await cache.load();
    const kvStore = KVStore.new_impl(cache);

    // Healthy write succeeds.
    expect(kvStore.write("monitors", "", "chan1", new Uint8Array([1])).is_ok()).toBeTruthy();
    expect(cache.isPersistenceHealthy()).toBe(true);

    // A write whose async persist rejects flips the cache to degraded.
    failWrites = true;
    const w2 = kvStore.write("monitors", "", "chan2", new Uint8Array([2]));
    expect(w2.is_ok()).toBeTruthy(); // synchronous ack fired before the async failure
    await new Promise((r) => setTimeout(r, 0)); // let the rejected persist settle
    expect(cache.isPersistenceHealthy()).toBe(false);

    // Every subsequent write is now refused (IOError) so LDK stops advancing state.
    const w3 = kvStore.write("monitors", "", "chan3", new Uint8Array([3]));
    expect(w3.is_ok()).toBeFalsy();
    const r3 = kvStore.remove("monitors", "", "chan1", false);
    expect(r3.is_ok()).toBeFalsy();
  });

  it("should initialize correctly from existing persisted data", async () => {
    const db = new Map<string, string>();
    db.set("ldk_keys_index", JSON.stringify(["rootkey", "ns/sub/nestedkey"]));
    db.set("rootkey", "010203");
    db.set("ns/sub/nestedkey", "040506");

    const mockStorage: SecureStorageProvider = {
      getItem: async (key) => db.get(key) || null,
      setItem: async (key, val) => {
        db.set(key, val);
      },
      removeItem: async (key) => {
        db.delete(key);
      },
    };

    const cache = new StorageCache(mockStorage);
    await cache.load();

    const kvStore = KVStore.new_impl(cache);

    // Check root key
    const readRoot = kvStore.read("", "", "rootkey");
    expect(readRoot.is_ok()).toBeTruthy();
    expect((readRoot as any).res).toEqual(new Uint8Array([1, 2, 3]));

    // Check nested key
    const readNested = kvStore.read("ns", "sub", "nestedkey");
    expect(readNested.is_ok()).toBeTruthy();
    expect((readNested as any).res).toEqual(new Uint8Array([4, 5, 6]));

    // List root keys (no namespace)
    const listRoot = kvStore.list("", "");
    expect((listRoot as any).res).toEqual(["rootkey"]);

    // List nested keys
    const listNested = kvStore.list("ns", "sub");
    expect((listNested as any).res).toEqual(["nestedkey"]);
  });
});
