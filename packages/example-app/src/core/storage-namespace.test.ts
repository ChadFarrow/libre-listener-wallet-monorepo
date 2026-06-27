import { describe, it, expect } from "vitest";
import { dbNameForNetwork, migrateStorage, type WritableStore } from "./storage-namespace";

function mem(init: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(init));
  return {
    m,
    keys: async () => [...m.keys()],
    getItem: async (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: async (k: string, v: string) => { m.set(k, v); },
  };
}

describe("dbNameForNetwork", () => {
  it("scopes the DB name by network", () => {
    expect(dbNameForNetwork("mainnet")).toBe("libre-wallet-mainnet");
    expect(dbNameForNetwork("regtest")).toBe("libre-wallet-regtest");
  });
});

describe("migrateStorage", () => {
  it("copies all keys (incl. preimage_*/monitors) into an empty target", async () => {
    const src = mem({ ldk_seed: "aa", channel_manager: "bb", preimage_x: "cc", "monitors/y": "dd" });
    const dst = mem();
    expect(await migrateStorage(src, dst)).toBe(4);
    expect(dst.m.get("ldk_seed")).toBe("aa");
    expect(dst.m.get("preimage_x")).toBe("cc");
    expect(dst.m.get("monitors/y")).toBe("dd");
  });

  it("skips and never overwrites a target that already has a wallet", async () => {
    const src = mem({ ldk_seed: "new", channel_manager: "new" });
    const dst = mem({ ldk_seed: "existing" });
    expect(await migrateStorage(src, dst)).toBe(0);
    expect(dst.m.get("ldk_seed")).toBe("existing");
    expect(dst.m.has("channel_manager")).toBe(false);
  });

  it("empty source copies nothing", async () => {
    expect(await migrateStorage(mem(), mem())).toBe(0);
  });

  it("writes ldk_seed last regardless of source key order", async () => {
    const writeOrder: string[] = [];
    const src = mem({ ldk_seed: "aa", channel_manager: "bb", "monitors/x": "cc" });
    const dst: WritableStore = {
      getItem: async (_k: string) => null, // empty target — migration will proceed
      setItem: async (k: string, _v: string) => { writeOrder.push(k); },
    };
    const count = await migrateStorage(src, dst);
    expect(count).toBe(3);
    expect(writeOrder[writeOrder.length - 1]).toBe("ldk_seed");
    expect(writeOrder).toContain("channel_manager");
    expect(writeOrder).toContain("monitors/x");
  });
});
