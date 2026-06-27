import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
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
});
