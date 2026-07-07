// @vitest-environment node
//
// SOAK: multiple wallets across multiple "devices" running CONCURRENTLY. Each device is an
// independent wallet (own seed + own storage Map = its own origin/IndexedDB), with its own channel
// to lnd and its own NWC pairing on a shared in-process relay. Every cycle, all devices drive a real
// NWC payment AT THE SAME TIME, then all RESTART at the same time — stressing the SDK's
// no-global-singleton design (concurrent LDK nodes, event loops, storage caches), the relay's
// multi-pairing routing, and per-device channel-state persistence under parallel load. A gotcha on
// ANY device (force-close, regression halt, lost channel, cross-talk, payment failure) is collected
// and reported so a long concurrent run surfaces interference bugs a single-wallet soak can't.
//
// Run locally (Mac):
//   docker compose up -d
//   MULTI_DEVICES=3 MULTI_CYCLES=4 pnpm --filter @libre/listener-wallet exec vitest run \
//     src/tests/integration/soak-multi-device.test.ts
// Set MULTI_VSS=1 to also enable a per-device VSS mirror (each seed → its own store).
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { bytesToHex } from "../../storage-cache";
import {
  createEsploraMsw,
  waitForLndSynced,
  newWallet,
  attachCloseWatcher,
  lndSeesActiveChannel,
  lndSeesForceClose,
  openZeroConfChannelToWallet,
  sleep,
  runCmdAsync,
  LNCLI,
} from "./soak-harness";
import { startNostrTestRelay, NostrTestRelay } from "./nostr-test-relay";
import { connectNwcClient, NwcClient } from "./nwc-test-client";
import { startVssTestServer, VssTestServer } from "./vss-test-server";
import type { LibreListenerWallet } from "../../index";

const DEVICES = parseInt(process.env.MULTI_DEVICES || "3", 10);
const CYCLES = parseInt(process.env.MULTI_CYCLES || "4", 10);
const USE_VSS = process.env.MULTI_VSS === "1";

interface Gotcha { device: number; cycle: number; kind: string; detail: string }

const mswServer = createEsploraMsw();
let lspPubkey = "";
let relay: NostrTestRelay;
let vss: VssTestServer | undefined;

const boostTlvHex = (dev: number) =>
  Buffer.from(JSON.stringify({ action: "boost", app_name: `multi-dev-${dev}` })).toString("hex");

// One device = one independent wallet instance on its own storage, with its own channel + NWC pairing.
interface Device {
  id: number;
  db: Map<string, string>;
  wallet: LibreListenerWallet;
  nodeId: string;
  client: NwcClient;
  closeReason: string | null;
  watcher: (e: any) => void;
}

describe("SOAK: multiple wallets across multiple devices, concurrent NWC + restart", () => {
  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: "bypass" });
    lspPubkey = await waitForLndSynced(lspPubkey);
    relay = await startNostrTestRelay();
    if (USE_VSS) vss = await startVssTestServer();
  }, 60000);
  afterEach(() => mswServer.resetHandlers());
  // Generous timeout: tearing down N devices' relay + VSS connections can take a moment.
  afterAll(async () => { mswServer.close(); await relay.close(); if (vss) await vss.close(); }, 30000);

  it(`runs ${DEVICES} devices concurrently through ${CYCLES} NWC-pay + restart cycles`, async () => {
    const gotchas: Gotcha[] = [];
    const devices: Device[] = [];

    // --- Setup: bring up every device (wallet + channel + NWC pairing) ---
    for (let i = 0; i < DEVICES; i++) {
      const db = new Map<string, string>();
      const dev: Device = { id: i, db, wallet: null as any, nodeId: "", client: null as any, closeReason: null, watcher: () => {} };
      dev.wallet = newWallet(db, { lspPubkey, ...(vss ? { vssUrl: vss.url } : {}) });
      dev.watcher = attachCloseWatcher(dev.wallet, (r) => { dev.closeReason = r; });
      await dev.wallet.start();
      dev.nodeId = bytesToHex(dev.wallet.getChannelManager()!.get_our_node_id());
      await openZeroConfChannelToWallet(dev.wallet, dev.nodeId, lspPubkey, { localAmtSat: 1000000, pushAmtSat: 300000 });
      expect(dev.wallet.getChannelManager()!.list_channels().length, `device ${i}: one channel after setup`).toBe(1);
      const pairingUri = await dev.wallet.nwc.createConnection(`multi-dev-${i}`, { relayUrl: relay.url, spendingLimitSats: 0 });
      dev.client = await connectNwcClient(pairingUri);
      devices.push(dev);
    }
    await sleep(2500); // let every wallet's relay subscription come up

    let paymentsOk = 0;
    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      for (const d of devices) d.closeReason = null;

      // 1. PARALLEL payments — every device pays at the same time (odd cycle = keysend send,
      //    even cycle = make_invoice that lnd pays). This is the concurrent multi-device load.
      await Promise.all(devices.map(async (d) => {
        try {
          if (cycle % 2 === 1) {
            const resp = await d.client.request("pay_keysend", {
              pubkey: lspPubkey,
              amount: 100_000,
              tlv_records: [{ type: 7629169, value: boostTlvHex(d.id) }],
            });
            if (resp.error) gotchas.push({ device: d.id, cycle, kind: "nwc-pay_keysend-error", detail: `${resp.error.code}: ${resp.error.message}` });
            else if (!resp.result?.preimage) gotchas.push({ device: d.id, cycle, kind: "nwc-pay_keysend-no-preimage", detail: JSON.stringify(resp) });
            else paymentsOk++;
          } else {
            const resp = await d.client.request("make_invoice", { amount: 200_000, description: `multi-dev-${d.id}-recv` });
            const invoice = resp.result?.invoice as string | undefined;
            if (resp.error || !invoice) gotchas.push({ device: d.id, cycle, kind: "nwc-make_invoice-error", detail: JSON.stringify(resp.error || resp) });
            else { await runCmdAsync(`${LNCLI} payinvoice --force --pay_req ${invoice}`).catch(() => ""); paymentsOk++; }
          }
        } catch (e) {
          gotchas.push({ device: d.id, cycle, kind: "nwc-request-threw", detail: e instanceof Error ? e.message : String(e) });
        }
      }));
      await sleep(1500);
      for (const d of devices) if (d.closeReason) gotchas.push({ device: d.id, cycle, kind: "force-close-during-payment", detail: d.closeReason });

      // 2. PARALLEL restart — every device restarts on its own storage at the same time.
      await Promise.all(devices.map(async (d) => {
        d.wallet.removeEventListener(d.watcher);
        await d.wallet.stop();
        d.wallet = newWallet(d.db, { lspPubkey, ...(vss ? { vssUrl: vss!.url } : {}) });
        d.closeReason = null;
        d.watcher = attachCloseWatcher(d.wallet, (r) => { d.closeReason = r; });
        try {
          await d.wallet.start();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          gotchas.push({ device: d.id, cycle, kind: msg.includes("CHANNEL_STATE_REGRESSION") ? "regression-halt-on-restart" : "start-threw", detail: msg });
        }
      }));

      // 3. PARALLEL reconnect + invariants per device.
      await Promise.all(devices.map(async (d) => {
        if (!d.wallet.getChannelManager()) return; // start() threw; already recorded
        const chans = d.wallet.getChannelManager()!.list_channels().length;
        if (chans !== 1) gotchas.push({ device: d.id, cycle, kind: "channel-lost-after-restart", detail: `list_channels=${chans}` });
        await d.wallet.connectPeer(lspPubkey, "127.0.0.1", 9735);
        for (let i = 0; i < 12 && !(await lndSeesActiveChannel(d.nodeId)); i++) await sleep(1000);
        if (d.closeReason) gotchas.push({ device: d.id, cycle, kind: "force-close-on-reestablish", detail: d.closeReason });
        if (await lndSeesForceClose(d.nodeId)) gotchas.push({ device: d.id, cycle, kind: "lnd-sees-force-close", detail: "channel in pendingchannels" });
      }));
      await sleep(2500); // let every restarted NwcManager re-subscribe before the next cycle

      console.log(`[multi-soak] cycle ${cycle}/${CYCLES} — devices=${devices.length}, payments ${paymentsOk}✓, gotchas=${gotchas.length}`);
    }

    for (const d of devices) { await d.client.close().catch(() => {}); await d.wallet.stop().catch(() => {}); }

    console.log(`\n[multi-soak] SUMMARY — devices=${DEVICES}, cycles=${CYCLES}, payments ${paymentsOk}✓, gotchas=${gotchas.length}`);
    for (const g of gotchas) console.log(`  [GOTCHA] device ${g.device} cycle ${g.cycle} :: ${g.kind} :: ${g.detail}`);
    expect(gotchas, `multi-device soak found ${gotchas.length} gotcha(s) — see log above`).toEqual([]);
  }, 30 * 60 * 1000);
});
