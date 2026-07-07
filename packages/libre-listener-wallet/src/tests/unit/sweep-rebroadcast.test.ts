import { describe, it, expect, vi } from "vitest";
import { LibreListenerWallet, SecureStorageProvider, WebSocketStreamProvider, WebSocketConnection } from "../../index";
import { bytesToHex } from "../../storage-cache";

// A force-close sweep whose broadcast fails (esplora 429 / offline) or is interrupted by a restart
// must NOT be dropped — it's persisted and retried until the node accepts it. (Old behavior dropped
// recoverable funds on the first broadcast failure.)
describe("force-close sweep rebroadcast queue", () => {
  const socketProvider: WebSocketStreamProvider = {
    connect: async () => ({ send: () => {}, close: () => {} } as unknown as WebSocketConnection),
  };
  function makeWallet(db: Record<string, string>) {
    const storage: SecureStorageProvider = {
      getItem: async (k) => db[k] ?? null,
      setItem: async (k, v) => { db[k] = v; },
      removeItem: async (k) => { delete db[k]; },
    };
    return new LibreListenerWallet({
      config: { network: "regtest", esploraUrl: "http://127.0.0.1:3002" },
      storage,
      socketProvider,
    }) as any;
  }
  const tx = new Uint8Array([1, 2, 3, 4]);
  const txHex = bytesToHex(tx);

  it("keeps a sweep queued + persisted when broadcast fails, then clears it once broadcast succeeds", async () => {
    const db: Record<string, string> = {};
    const wallet = makeWallet(db);
    let shouldFail = true;
    wallet.syncClient = { broadcastTransaction: vi.fn(async () => { if (shouldFail) throw new Error("429"); }) };
    wallet.pendingSweeps.set(txHex, tx);
    await wallet.persistPendingSweeps();
    expect(JSON.parse(db["sweep_pending_txs"])).toEqual([txHex]);

    // First attempt fails → still queued + persisted (not dropped).
    await wallet.broadcastPendingSweeps();
    expect(wallet.pendingSweeps.has(txHex)).toBe(true);
    expect(JSON.parse(db["sweep_pending_txs"])).toEqual([txHex]);

    // Next attempt succeeds → dropped from queue + storage.
    shouldFail = false;
    await wallet.broadcastPendingSweeps();
    expect(wallet.pendingSweeps.has(txHex)).toBe(false);
    expect(JSON.parse(db["sweep_pending_txs"])).toEqual([]);
  });

  it("recovers persisted sweeps across a restart via loadPendingSweeps", async () => {
    const db: Record<string, string> = { sweep_pending_txs: JSON.stringify([txHex]) };
    const wallet = makeWallet(db);
    await wallet.loadPendingSweeps();
    expect(wallet.pendingSweeps.has(txHex)).toBe(true);
    expect(bytesToHex(wallet.pendingSweeps.get(txHex))).toBe(txHex);
  });

  it("ignores a malformed persisted entry", async () => {
    const db: Record<string, string> = { sweep_pending_txs: JSON.stringify(["zzz", 123, "aabb"]) };
    const wallet = makeWallet(db);
    await wallet.loadPendingSweeps();
    expect(wallet.pendingSweeps.has("aabb")).toBe(true);
    expect(wallet.pendingSweeps.has("zzz")).toBe(false);
    expect(wallet.pendingSweeps.size).toBe(1);
  });
});
