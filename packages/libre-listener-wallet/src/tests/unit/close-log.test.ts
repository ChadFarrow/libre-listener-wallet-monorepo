import { describe, it, expect } from "vitest";
import { CloseLogger, CLOSE_KEY_PREFIX, type ChannelCloseRecord } from "../../close-log";
import type { SecureStorageProvider } from "../../index";

function memoryStorage(): SecureStorageProvider & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => void map.set(k, v),
    removeItem: async (k) => void map.delete(k),
    keys: async () => [...map.keys()],
  };
}

const CLOSE: ChannelCloseRecord = {
  channelId: "15bec31c98a700c08436f459c00e0c9b5258972aa21cc4ebddb82eb8c6a963b9",
  counterpartyNodeId: "028ea4e01d6f7e6d80d2d6902eda9304c4bcda78a6abfda3dee2de94ef46a302d5",
  capacitySat: 100_000,
  reason: "counterparty-force-closed",
  closedAt: 1_783_775_545_000,
};

describe("CloseLogger", () => {
  it("persists a close under close_<channelId> and returns it newest-first", async () => {
    const storage = memoryStorage();
    const log = new CloseLogger({ storage });
    log.record(CLOSE);
    log.record({ ...CLOSE, channelId: "aa".repeat(32), closedAt: CLOSE.closedAt + 1000 });
    await new Promise((r) => setTimeout(r, 0)); // fire-and-forget persist settles
    expect(storage.map.has(`${CLOSE_KEY_PREFIX}${CLOSE.channelId}`)).toBe(true);
    const recs = log.getRecords();
    expect(recs).toHaveLength(2);
    expect(recs[0].channelId).toBe("aa".repeat(32)); // newest first
  });

  it("rehydrates from storage via load() and skips unreadable records", async () => {
    const storage = memoryStorage();
    storage.map.set(`${CLOSE_KEY_PREFIX}${CLOSE.channelId}`, JSON.stringify(CLOSE));
    storage.map.set(`${CLOSE_KEY_PREFIX}bad`, "{not json");
    storage.map.set("tx_unrelated", "{}"); // other prefixes ignored
    const log = new CloseLogger({ storage });
    await log.load();
    expect(log.isLoaded()).toBe(true);
    expect(log.getRecords()).toEqual([CLOSE]);
  });

  it("a re-fired close for the same channel upserts (no duplicates)", async () => {
    const storage = memoryStorage();
    const log = new CloseLogger({ storage });
    log.record(CLOSE);
    log.record({ ...CLOSE, reason: "force-closed" }); // LDK can re-emit on restart
    expect(log.getRecords()).toHaveLength(1);
    expect(log.getRecords()[0].reason).toBe("force-closed");
  });
});
