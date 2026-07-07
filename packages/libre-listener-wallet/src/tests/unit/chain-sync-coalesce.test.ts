import { describe, it, expect, vi } from "vitest";
import { LibreListenerWallet, SecureStorageProvider, WebSocketStreamProvider, WebSocketConnection } from "../../index";

// runChainSync() must coalesce concurrent chain syncs into a single in-flight run so LDK's
// Confirm interface never sees two overlapping EsploraSyncClient.sync() passes interleave
// block/tx updates out of order (which can regress the best block). Mirrors syncGossip.
describe("chain sync coalescing (runChainSync)", () => {
  const socketProvider: WebSocketStreamProvider = {
    connect: async () => ({ send: () => {}, close: () => {} } as unknown as WebSocketConnection),
  };
  const storage: SecureStorageProvider = {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  };

  function makeWallet() {
    return new LibreListenerWallet({
      config: { network: "regtest", esploraUrl: "http://127.0.0.1:3002" },
      storage,
      socketProvider,
    });
  }

  it("runs only one sync at a time and lets concurrent callers share it", async () => {
    const wallet = makeWallet() as any;
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    wallet.channelManager = {};
    wallet.chainMonitor = {};
    wallet.syncClient = {
      sync: vi.fn(async () => {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        await gate; // hold the sync open so a second call would overlap if not coalesced
        active--;
      }),
    };

    const p1 = wallet.runChainSync();
    const p2 = wallet.runChainSync(); // arrives while p1 is in-flight
    expect(p2).toBe(p1); // same in-flight promise, no second sync started
    release();
    await Promise.all([p1, p2]);

    expect(calls).toBe(1);
    expect(maxActive).toBe(1);

    // After the in-flight run settles, a new call starts a fresh sync.
    const p3 = wallet.runChainSync();
    await p3;
    expect(calls).toBe(2);
  });

  it("no-ops safely when the node objects are absent", async () => {
    const wallet = makeWallet() as any;
    await expect(wallet.runChainSync()).resolves.toBeUndefined();
  });
});
