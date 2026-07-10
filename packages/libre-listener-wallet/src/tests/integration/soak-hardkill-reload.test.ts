// @vitest-environment node
//
// SOAK: HARD-KILL the wallet mid-life (no stop(), storage writes dropped, sockets severed — what a
// browser tab reload/crash actually does) and restart on the surviving storage. Pre-fix this
// deterministically force-closed: the channel_manager persisted lazily (stop()/export only), so the
// reloaded node found monitor N + manager N-k and LDK resolved it with reason
// OutdatedChannelManager, broadcasting the commitment ("A ChannelManager is stale compared to the
// current ChannelMonitor!" — reproduced live on mainnet AND regtest 2026-07-09). The fix couples a
// manager snapshot into the SAME durable batch as every monitor update (composeDurableFlush), so a
// kill can never leave the manager behind the monitors.
//
// Requires the docker regtest stack. Every existing soak restarts CLEANLY via stop() — this is the
// only one that reproduces the browser-kill trigger.
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import {
  LibreListenerWallet,
  SecureStorageProvider,
  WebSocketStreamProvider,
  WebSocketConnection,
} from "../../index";
import { bytesToHex } from "../../storage-cache";
import { Event } from "lightningdevkit";
import {
  createEsploraMsw,
  waitForLndSynced,
  openZeroConfChannelToWallet,
  attachCloseWatcher,
  lndSeesActiveChannel,
  lndSeesForceClose,
  loadWasmBinary,
  TCPStreamProvider,
  sleep,
} from "./soak-harness";

// Storage whose writes HANG (never resolve, never land) once killed — an acked-but-uncommitted
// IndexedDB write on a dying page. Reads keep working (they don't matter post-kill).
function killableStorage(db: Map<string, string>, isKilled: () => boolean): SecureStorageProvider {
  return {
    getItem: async (k) => db.get(k) || null,
    setItem: (k, v) => {
      if (isKilled()) return new Promise<void>(() => {});
      db.set(k, v);
      return Promise.resolve();
    },
    removeItem: (k) => {
      if (isKilled()) return new Promise<void>(() => {});
      db.delete(k);
      return Promise.resolve();
    },
  };
}

// Transport that severs every live socket on kill and refuses new dials — the killed page's
// connections drop and its zombie can never redial.
class KillableTransport implements WebSocketStreamProvider {
  private inner = new TCPStreamProvider();
  private conns: WebSocketConnection[] = [];
  constructor(private isKilled: () => boolean) {}
  async connect(address: string, port: number): Promise<WebSocketConnection> {
    if (this.isKilled()) throw new Error("killed");
    const conn = await this.inner.connect(address, port);
    this.conns.push(conn);
    return conn;
  }
  severAll(): void {
    for (const c of this.conns) {
      try {
        c.close();
      } catch {
        /* already gone */
      }
    }
    this.conns = [];
  }
}

const mswServer = createEsploraMsw();
let lspPubkey = "";

describe("SOAK: hard-kill reload must not force-close (OutdatedChannelManager)", () => {
  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: "bypass" });
    lspPubkey = await waitForLndSynced(lspPubkey);
  }, 60000);
  afterEach(() => mswServer.resetHandlers());
  afterAll(() => mswServer.close());

  it(
    "channel survives: payments → hard kill (no stop, writes dropped) → restart → more payments",
    async () => {
      const db = new Map<string, string>();
      let killed = false;
      const isKilled = () => killed;

      // --- Wallet A: fund it and drive payments (the state-advance that used to outrun the manager) ---
      const transportA = new KillableTransport(isKilled);
      const walletA = new LibreListenerWallet({
        config: { network: "regtest", esploraUrl: "http://127.0.0.1:3002", trustedZeroConfPeers: [lspPubkey] },
        storage: killableStorage(db, isKilled),
        socketProvider: transportA,
        wasmBinary: loadWasmBinary(),
      });
      await walletA.start();
      const nodeId = bytesToHex(walletA.getChannelManager()!.get_our_node_id());
      await openZeroConfChannelToWallet(walletA, nodeId, lspPubkey, { localAmtSat: 1_000_000, pushAmtSat: 200_000 });

      for (let i = 0; i < 2; i++) {
        const res = await walletA.sendKeysendPayment({
          destinationPubkey: lspPubkey,
          amountSats: 500,
          customRecords: { 7629169: JSON.stringify({ action: "boost", app_name: "hardkill-soak" }) },
        });
        expect(res.ok, `keysend ${i + 1} before the kill`).toBe(true);
        await sleep(2000);
      }

      // --- The kill burst: advance channel state and kill INSIDE the manager-persist tick window.
      // The manager historically persisted on a ~1s event tick, so monitor updates from these
      // payments land durably while the tick that would write the matching manager snapshot has
      // not fired yet — the exact browser-kill interleaving that produced OutdatedChannelManager.
      const burst1 = await walletA.sendKeysendPayment({
        destinationPubkey: lspPubkey,
        amountSats: 500,
        customRecords: { 7629169: JSON.stringify({ action: "boost", app_name: "hardkill-burst" }) },
      });
      expect(burst1.ok, "burst keysend initiated").toBe(true);
      await sleep(300);

      // --- HARD KILL: no stop(), no teardown. Un-issued writes never happen, sockets drop. ---
      killed = true;
      transportA.severAll();
      await sleep(1000);

      // --- Wallet B: a fresh instance over the SURVIVING storage (what the reloaded page loads) ---
      const dbB = db; // same underlying data; a fresh, healthy provider view
      let closeReason: string | null = null;
      const walletB = new LibreListenerWallet({
        config: { network: "regtest", esploraUrl: "http://127.0.0.1:3002", trustedZeroConfPeers: [lspPubkey] },
        storage: {
          getItem: async (k) => dbB.get(k) || null,
          setItem: async (k, v) => {
            dbB.set(k, v);
          },
          removeItem: async (k) => {
            dbB.delete(k);
          },
        },
        socketProvider: new TCPStreamProvider(),
        wasmBinary: loadWasmBinary(),
      });
      attachCloseWatcher(walletB, (r) => {
        closeReason = r;
      });

      await walletB.start(); // pre-fix: LDK logs "ChannelManager is stale" here and queues the force-close
      await walletB.connectPeer(lspPubkey, "127.0.0.1", 9735);
      await sleep(5000);

      // --- The invariants the fix guarantees ---
      expect(closeReason, "no ChannelClosed event after the hard-kill reload").toBeNull();
      const channels = walletB.getChannels();
      expect(channels.length, "channel still present").toBe(1);
      expect(channels[0].isUsable, "channel usable after reestablish").toBeTruthy();
      expect(await lndSeesForceClose(nodeId), "lnd must not be force-closing").toBe(false);
      expect(await lndSeesActiveChannel(nodeId), "lnd sees the channel active").toBe(true);

      // And the channel still MOVES money.
      const after = await walletB.sendKeysendPayment({
        destinationPubkey: lspPubkey,
        amountSats: 500,
        customRecords: { 7629169: JSON.stringify({ action: "boost", app_name: "hardkill-soak-after" }) },
      });
      expect(after.ok, "keysend after the hard-kill reload").toBe(true);
      await sleep(2000);
      expect(closeReason, "still no close after post-reload payment").toBeNull();

      await walletB.stop();
    },
    240000
  );
});
