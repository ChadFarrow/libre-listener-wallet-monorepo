// @vitest-environment node
//
// SOAK: prove the VSS durable-replica RECOVERS a channel after a local "channel info reset" — the
// exact failure that force-closed an NWC session. Each cycle: advance channel state with a payment,
// let the VSS mirror upload the encrypted envelope, then WIPE all local storage except the seed
// (simulating storage loss / a channel-info reset), restart, and assert the wallet RE-HYDRATES the
// channel from VSS and reconnects with NO force-close — instead of bootstrapping an empty node and
// force-closing on reestablish. Uses an in-process VSS server, so no extra infra beyond docker regtest.
//
// Run locally (Mac):
//   docker compose up -d
//   VSS_RECOVER_CYCLES=5 pnpm --filter @libre/listener-wallet exec vitest run \
//     src/tests/integration/soak-vss-recovery.test.ts
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { bytesToHex } from "../../storage-cache";
import { deriveVssStoreId } from "../../index";
import {
  createEsploraMsw,
  waitForLndSynced,
  newWallet,
  attachCloseWatcher,
  lndSeesActiveChannel,
  lndSeesForceClose,
  openZeroConfChannelToWallet,
  sleep,
} from "./soak-harness";
import { startVssTestServer, VssTestServer } from "./vss-test-server";

const RECOVER_CYCLES = parseInt(process.env.VSS_RECOVER_CYCLES || "3", 10);
const MIRROR_WAIT_MS = 6000; // > the 5s VSS mirror debounce, so the latest state is uploaded

interface Gotcha { cycle: number; kind: string; detail: string }

const mswServer = createEsploraMsw();
let lspPubkey = "";
let vss: VssTestServer;

describe("SOAK: VSS re-hydrates the channel after a local-state wipe (no force-close)", () => {
  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: "bypass" });
    lspPubkey = await waitForLndSynced(lspPubkey);
    vss = await startVssTestServer();
  }, 60000);
  afterEach(() => mswServer.resetHandlers());
  afterAll(async () => { mswServer.close(); await vss.close(); });

  it(`recovers from ${RECOVER_CYCLES} local-state wipes via VSS`, async () => {
    const gotchas: Gotcha[] = [];
    const db = new Map<string, string>();

    // --- Setup: wallet WITH vssUrl, open one funded channel ---
    let wallet = newWallet(db, { lspPubkey, vssUrl: vss.url });
    let closeReason: string | null = null;
    let watcher = attachCloseWatcher(wallet, (r) => { closeReason = r; });
    await wallet.start();
    const nodeId = bytesToHex(wallet.getChannelManager()!.get_our_node_id());
    const seedHex = db.get("ldk_seed")!;
    const storeId = await deriveVssStoreId(seedHex);
    await openZeroConfChannelToWallet(wallet, nodeId, lspPubkey, { localAmtSat: 1000000, pushAmtSat: 200000 });
    expect(wallet.getChannelManager()!.list_channels().length, "one channel after setup").toBe(1);

    for (let cycle = 1; cycle <= RECOVER_CYCLES; cycle++) {
      closeReason = null;

      // 1. Advance channel state with a payment (also proves the current channel works).
      const res = await wallet.sendKeysendPayment({
        destinationPubkey: lspPubkey,
        amountSats: 100,
        customRecords: { 7629169: JSON.stringify({ action: "boost", app_name: "libre-vss-soak" }) },
      });
      if (!res.ok) gotchas.push({ cycle, kind: "payment-failed", detail: res.error || "unknown" });
      await sleep(1500);
      if (closeReason) gotchas.push({ cycle, kind: "force-close-during-payment", detail: closeReason });

      // 2. Let the debounced VSS mirror upload the post-payment state, then verify VSS holds it.
      await sleep(MIRROR_WAIT_MS);
      const mirrored = vss.getValue(storeId, "state_backup");
      if (!mirrored || mirrored.length === 0) {
        gotchas.push({ cycle, kind: "vss-mirror-missing", detail: "no state_backup blob before wipe" });
      }

      // 3. WIPE all local storage except the seed — a "channel info reset" / storage loss.
      await wallet.removeEventListener(watcher);
      await wallet.stop();
      for (const k of [...db.keys()]) if (k !== "ldk_seed") db.delete(k);
      expect(db.get("channel_manager"), "channel state must be gone after wipe").toBeUndefined();

      // 4. Restart: with the seed present but no local channel state, start() must RE-HYDRATE from VSS
      //    BEFORE dialing — not bootstrap an empty node.
      wallet = newWallet(db, { lspPubkey, vssUrl: vss.url });
      closeReason = null;
      watcher = attachCloseWatcher(wallet, (r) => { closeReason = r; });
      try {
        await wallet.start();
      } catch (e) {
        gotchas.push({ cycle, kind: "start-threw-after-wipe", detail: e instanceof Error ? e.message : String(e) });
        break;
      }

      const chans = wallet.getChannelManager()!.list_channels().length;
      if (chans !== 1) {
        gotchas.push({ cycle, kind: "not-rehydrated-from-vss", detail: `list_channels=${chans} (expected 1)` });
      }

      // 5. Reconnect + reestablish — a data-loss reestablish would force-close here. It must NOT.
      await wallet.connectPeer(lspPubkey, "127.0.0.1", 9735);
      for (let i = 0; i < 12 && !(await lndSeesActiveChannel(nodeId)); i++) await sleep(1000);
      if (closeReason) gotchas.push({ cycle, kind: "force-close-after-vss-restore", detail: closeReason });
      if (await lndSeesForceClose(nodeId)) gotchas.push({ cycle, kind: "lnd-sees-force-close", detail: "channel in pendingchannels" });

      console.log(`[vss-soak] cycle ${cycle}/${RECOVER_CYCLES} — rehydrated channels=${chans}, gotchas=${gotchas.length}`);
    }

    await wallet.stop();

    console.log(`\n[vss-soak] SUMMARY — gotchas=${gotchas.length}`);
    for (const g of gotchas) console.log(`  [GOTCHA] cycle ${g.cycle} :: ${g.kind} :: ${g.detail}`);
    expect(gotchas, `VSS-recovery soak found ${gotchas.length} gotcha(s) — see log above`).toEqual([]);
  }, 20 * 60 * 1000);
});
