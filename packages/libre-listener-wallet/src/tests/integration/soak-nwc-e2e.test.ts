// @vitest-environment node
//
// SOAK: drive payments through the REAL NWC/Nostr flow (not the SDK send API directly) while
// restarting the wallet — the faithful reproduction of the NWC session that force-closed. An
// in-process Nostr relay carries NIP-47 traffic between a test NWC client and the wallet's
// NwcManager; each cycle the client sends a pay_keysend (and every other cycle a make_invoice that
// lnd then pays), the wallet is RESTARTED on the same storage (NWC key + pairing persist), and the
// channel must SURVIVE with no force-close.
//
// Run locally (Mac):
//   docker compose up -d
//   NWC_CYCLES=10 pnpm --filter @libre/listener-wallet exec vitest run \
//     src/tests/integration/soak-nwc-e2e.test.ts
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

const NWC_CYCLES = parseInt(process.env.NWC_CYCLES || "4", 10);

interface Gotcha { cycle: number; kind: string; detail: string }

const mswServer = createEsploraMsw();
let lspPubkey = "";
let relay: NostrTestRelay;

const boostTlvHex = () => Buffer.from(JSON.stringify({ action: "boost", app_name: "libre-nwc-soak" })).toString("hex");

describe("SOAK: real NWC pay flow + restart must not force-close the channel", () => {
  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: "bypass" });
    lspPubkey = await waitForLndSynced(lspPubkey);
    relay = await startNostrTestRelay();
  }, 60000);
  afterEach(() => mswServer.resetHandlers());
  afterAll(async () => { mswServer.close(); await relay.close(); });

  it(`survives ${NWC_CYCLES} NWC-pay + restart cycles`, async () => {
    const gotchas: Gotcha[] = [];
    const db = new Map<string, string>();

    // --- Setup: wallet + channel, then a NWC pairing on the in-process relay ---
    let wallet = newWallet(db, { lspPubkey });
    let closeReason: string | null = null;
    let watcher = attachCloseWatcher(wallet, (r) => { closeReason = r; });
    await wallet.start();
    const nodeId = bytesToHex(wallet.getChannelManager()!.get_our_node_id());
    await openZeroConfChannelToWallet(wallet, nodeId, lspPubkey, { localAmtSat: 1000000, pushAmtSat: 300000 });
    expect(wallet.getChannelManager()!.list_channels().length, "one channel after setup").toBe(1);

    // Unlimited, all-methods pairing on our relay; returns the nostr+walletconnect:// URI.
    const pairingUri = await wallet.nwc.createConnection("soak", { relayUrl: relay.url, spendingLimitSats: 0 });
    const client: NwcClient = await connectNwcClient(pairingUri);
    await sleep(2000); // let the wallet's relay subscription come up

    let paymentsOk = 0;
    for (let cycle = 1; cycle <= NWC_CYCLES; cycle++) {
      closeReason = null;

      // 1. Drive a payment through the REAL NWC flow.
      try {
        if (cycle % 2 === 1) {
          // Send: pay_keysend (V4V boost) — amount in msat.
          const resp = await client.request("pay_keysend", {
            pubkey: lspPubkey,
            amount: 100_000,
            tlv_records: [{ type: 7629169, value: boostTlvHex() }],
          });
          if (resp.error) gotchas.push({ cycle, kind: "nwc-pay_keysend-error", detail: `${resp.error.code}: ${resp.error.message}` });
          else if (!resp.result?.preimage) gotchas.push({ cycle, kind: "nwc-pay_keysend-no-preimage", detail: JSON.stringify(resp) });
          else paymentsOk++;
        } else {
          // Receive: make_invoice via NWC, then lnd pays it.
          const resp = await client.request("make_invoice", { amount: 200_000, description: "nwc-soak-receive" });
          const invoice = resp.result?.invoice as string | undefined;
          if (resp.error || !invoice) gotchas.push({ cycle, kind: "nwc-make_invoice-error", detail: JSON.stringify(resp.error || resp) });
          else {
            await runCmdAsync(`${LNCLI} payinvoice --force --pay_req ${invoice}`).catch(() => "");
            paymentsOk++;
          }
        }
      } catch (e) {
        gotchas.push({ cycle, kind: "nwc-request-threw", detail: e instanceof Error ? e.message : String(e) });
      }
      await sleep(1500);
      if (closeReason) gotchas.push({ cycle, kind: "force-close-during-nwc-payment", detail: closeReason });

      // 2. RESTART on the same storage (NWC key + pairing persist in the DB).
      wallet.removeEventListener(watcher);
      await wallet.stop();
      wallet = newWallet(db, { lspPubkey });
      closeReason = null;
      watcher = attachCloseWatcher(wallet, (r) => { closeReason = r; });
      try {
        await wallet.start();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        gotchas.push({ cycle, kind: msg.includes("CHANNEL_STATE_REGRESSION") ? "regression-halt-on-restart" : "start-threw", detail: msg });
        break;
      }

      // 3. Invariants: channel survives, reconnects, no force-close. The wallet's NwcManager
      //    re-subscribes to the relay on start, so the next cycle's NWC request hits the new instance.
      const chans = wallet.getChannelManager()!.list_channels().length;
      if (chans !== 1) gotchas.push({ cycle, kind: "channel-lost-after-restart", detail: `list_channels=${chans}` });
      await wallet.connectPeer(lspPubkey, "127.0.0.1", 9735);
      for (let i = 0; i < 12 && !(await lndSeesActiveChannel(nodeId)); i++) await sleep(1000);
      if (closeReason) gotchas.push({ cycle, kind: "force-close-on-reestablish", detail: closeReason });
      if (await lndSeesForceClose(nodeId)) gotchas.push({ cycle, kind: "lnd-sees-force-close", detail: "channel in pendingchannels" });
      await sleep(2000); // give the restarted NwcManager time to re-subscribe before the next request

      console.log(`[nwc-soak] cycle ${cycle}/${NWC_CYCLES} — payments ${paymentsOk}✓, channels=${chans}, gotchas=${gotchas.length}`);
    }

    await client.close();
    await wallet.stop();

    console.log(`\n[nwc-soak] SUMMARY — payments ${paymentsOk}✓, gotchas=${gotchas.length}`);
    for (const g of gotchas) console.log(`  [GOTCHA] cycle ${g.cycle} :: ${g.kind} :: ${g.detail}`);
    expect(gotchas, `NWC soak found ${gotchas.length} gotcha(s) — see log above`).toEqual([]);
  }, 20 * 60 * 1000);
});
