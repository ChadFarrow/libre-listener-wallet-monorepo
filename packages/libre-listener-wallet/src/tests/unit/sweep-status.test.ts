import { describe, it, expect } from "vitest";
import { LibreListenerWallet, type SecureStorageProvider, type WebSocketStreamProvider, type WebSocketConnection } from "../../index";

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

const mockSocketProvider: WebSocketStreamProvider = {
  connect: async () => ({ send: () => {}, close: () => {} }) as unknown as WebSocketConnection,
};

function makeWallet(storage: SecureStorageProvider) {
  return new LibreListenerWallet({
    config: { network: "regtest", esploraUrl: "http://127.0.0.1:3002" },
    storage,
    socketProvider: mockSocketProvider,
  } as unknown as ConstructorParameters<typeof LibreListenerWallet>[0]);
}

describe("getSweepStatus", () => {
  it("starts clean", () => {
    const w = makeWallet(memoryStorage());
    expect(w.getSweepStatus()).toEqual({ needsAddress: false, pendingCount: 0, pendingSat: 0 });
  });

  it("flags needsAddress when spendable outputs arrive with no destination, clears when one is set", () => {
    const w = makeWallet(memoryStorage());
    // handleSpendableOutputs is private; drive it directly — asserting via the public getter.
    const handled = (w as any).handleSpendableOutputs([{ output: { value: 93_813n } }]);
    expect(handled).toBe(false); // LDK will replay the event — unchanged behavior
    expect(w.getSweepStatus().needsAddress).toBe(true);
    w.setSweepDestination(new Uint8Array([0x00, 0x14, ...new Array(20).fill(1)]));
    expect(w.getSweepStatus().needsAddress).toBe(false);
  });

  it("rehydrates lastSweep from storage at start-time load", async () => {
    const storage = memoryStorage();
    const last = { txid: "ab".repeat(32), sat: 93_813, at: 1_783_775_545_000 };
    storage.map.set("sweep_last", JSON.stringify(last));
    const w = makeWallet(storage);
    await (w as any).loadPendingSweeps();
    expect(w.getSweepStatus().lastSweep).toEqual(last);
  });
});
