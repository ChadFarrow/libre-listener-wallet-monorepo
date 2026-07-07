import { describe, it, expect, vi } from "vitest";
import { LibreListenerWallet, SecureStorageProvider, WebSocketStreamProvider, WebSocketConnection } from "../../index";
import { bytesToHex } from "../../storage-cache";

// recordDurableHighwater is invoked from createDurablePersist's onDurablePersisted hook AFTER a
// monitor durably persists. It maps the funding outpoint → channelId via list_monitors() and
// advances the persisted high-water — monotonically, and only to durably-committed update ids
// (never ahead of on-disk state, so the regression guard can't false-halt on the next load).
describe("recordDurableHighwater", () => {
  const socketProvider: WebSocketStreamProvider = {
    connect: async () => ({ send: () => {}, close: () => {} } as unknown as WebSocketConnection),
  };
  function makeWallet(writes: Record<string, string>) {
    const storage: SecureStorageProvider = {
      getItem: async (k) => writes[k] ?? null,
      setItem: async (k, v) => { writes[k] = v; },
      removeItem: async (k) => { delete writes[k]; },
    };
    return new LibreListenerWallet({
      config: { network: "regtest", esploraUrl: "http://127.0.0.1:3002" },
      storage,
      socketProvider,
    }) as any;
  }

  const txidLe = new Uint8Array(32).fill(7);
  const channelIdBytes = new Uint8Array(32).fill(9);
  const channelIdHex = bytesToHex(channelIdBytes);

  function mockChainMonitor(matchTxid: Uint8Array, index: number) {
    return {
      list_monitors: () => [
        {
          get_a: () => ({ get_txid: () => matchTxid, get_index: () => index }),
          get_b: () => ({ get_a: () => channelIdBytes }),
        },
      ],
    };
  }

  it("advances + persists the high-water for the matching channel", async () => {
    const writes: Record<string, string> = {};
    const wallet = makeWallet(writes);
    wallet.chainMonitor = mockChainMonitor(txidLe, 0);
    wallet.monitorHighwater = new Map();

    wallet.recordDurableHighwater(txidLe, 0, 5n);
    await new Promise((r) => setTimeout(r, 0));

    expect(writes["monitor_update_highwater"]).toBeDefined();
    expect(writes["monitor_update_highwater"]).toContain(channelIdHex);
    expect(writes["monitor_update_highwater"]).toContain("5");
  });

  it("is monotonic — a lower update id does not move the mark", async () => {
    const writes: Record<string, string> = {};
    const wallet = makeWallet(writes);
    wallet.chainMonitor = mockChainMonitor(txidLe, 0);
    wallet.monitorHighwater = new Map();

    wallet.recordDurableHighwater(txidLe, 0, 5n);
    await new Promise((r) => setTimeout(r, 0));
    const afterFirst = writes["monitor_update_highwater"];
    // A stale/lower id must NOT regress the persisted mark.
    wallet.recordDurableHighwater(txidLe, 0, 3n);
    await new Promise((r) => setTimeout(r, 0));
    expect(writes["monitor_update_highwater"]).toBe(afterFirst);
  });

  it("no-ops when the outpoint matches no live monitor (channel closed between persist and ack)", async () => {
    const writes: Record<string, string> = {};
    const wallet = makeWallet(writes);
    wallet.chainMonitor = mockChainMonitor(new Uint8Array(32).fill(1), 0); // different txid
    wallet.monitorHighwater = new Map();

    wallet.recordDurableHighwater(txidLe, 0, 5n);
    await new Promise((r) => setTimeout(r, 0));
    expect(writes["monitor_update_highwater"]).toBeUndefined();
  });
});
