// @vitest-environment node
//
// SOAK: hammer the restart / storage-reload path while payments flow, to smoke out the
// "a channel info reset closed the channel" force-close class (state desync on reload under load —
// the same failure that hit an NWC session). One channel is opened once; then for SOAK_CYCLES the
// wallet sends/receives a small payment and is RESTARTED on the same persistent storage (a fresh
// wallet instance re-reading the same DB — exactly what a browser reload / offscreen-reap does),
// asserting the channel SURVIVES every cycle. Every anomaly (force-close event, regression HALT,
// non-monotonic state, lost channel) is collected and reported at the end rather than bailing on
// the first, so a long run surfaces intermittent gotchas.
//
// Run locally (Mac) against the docker regtest stack:
//   docker compose up -d
//   SOAK_CYCLES=50 pnpm --filter @libre/listener-wallet exec vitest run \
//     src/tests/integration/soak-nwc-restart.test.ts
// SOAK_CYCLES (default 8) sets the loop length; bump it for a longer soak. The payments go directly
// through the SDK send/receive path — the SAME channel-state-advance + persist path NWC drives.
// (soak-nwc-e2e.test.ts drives the identical loop through the real NWC/Nostr flow.)
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

const SOAK_CYCLES = parseInt(process.env.SOAK_CYCLES || "8", 10);

interface Gotcha { cycle: number; kind: string; detail: string }

const mswServer = createEsploraMsw();
let lspPubkey = "";

describe("SOAK: restart + payments must not reset/force-close the channel", () => {
  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: "bypass" });
    lspPubkey = await waitForLndSynced(lspPubkey);
  }, 60000);
  afterEach(() => mswServer.resetHandlers());
  afterAll(() => mswServer.close());

  it(`survives ${SOAK_CYCLES} pay+restart cycles with no force-close or state reset`, async () => {
    const gotchas: Gotcha[] = [];
    const db = new Map<string, string>();

    // --- Setup: open one channel (lnd -> wallet, zero-conf, wallet gets 200k pushed for sends) ---
    let wallet = newWallet(db, { lspPubkey });
    let closeReason: string | null = null;
    let watcher = attachCloseWatcher(wallet, (r) => { closeReason = r; });
    await wallet.start();
    const nodeId = bytesToHex(wallet.getChannelManager()!.get_our_node_id());
    await openZeroConfChannelToWallet(wallet, nodeId, lspPubkey, { localAmtSat: 1000000, pushAmtSat: 200000 });

    expect(wallet.getChannelManager()!.list_channels().length, "expected exactly one channel after setup").toBe(1);
    let lastStateVersion = wallet.getStateVersion();

    // --- Soak loop: pay (alternating send/receive) then restart on the SAME storage ---
    let paymentsOk = 0;
    let paymentsFailed = 0;
    for (let cycle = 1; cycle <= SOAK_CYCLES; cycle++) {
      closeReason = null;

      // 1. A small payment to advance channel state (the load that precedes the reset).
      try {
        if (cycle % 2 === 1) {
          const res = await wallet.sendKeysendPayment({
            destinationPubkey: lspPubkey,
            amountSats: 300,
            customRecords: { 7629169: JSON.stringify({ action: "boost", app_name: "libre-soak" }) },
          });
          if (res.ok) paymentsOk++; else { paymentsFailed++; gotchas.push({ cycle, kind: "send-failed", detail: res.error || "unknown" }); }
        } else {
          const invoice = await wallet.createInvoice(200, "soak-receive");
          await runCmdAsync(`${LNCLI} payinvoice --force --pay_req ${invoice}`).catch(() => "");
          paymentsOk++;
        }
      } catch (e) {
        paymentsFailed++;
        gotchas.push({ cycle, kind: "payment-threw", detail: e instanceof Error ? e.message : String(e) });
      }
      await sleep(1500);
      if (closeReason) gotchas.push({ cycle, kind: "force-close-during-payment", detail: closeReason });

      // 2. RESTART on the same persistent storage — the reload path that reset the channel.
      wallet.removeEventListener(watcher);
      await wallet.stop();

      wallet = newWallet(db, { lspPubkey });
      closeReason = null;
      watcher = attachCloseWatcher(wallet, (r) => { closeReason = r; });

      // 3. start() may THROW ChannelStateRegressionError — the guard HALTING on a detected reset
      //    (the SAFE outcome, but we record it so a long soak reveals a false-halt on clean restart).
      try {
        await wallet.start();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        gotchas.push({ cycle, kind: msg.includes("CHANNEL_STATE_REGRESSION") ? "regression-halt-on-restart" : "start-threw", detail: msg });
        break;
      }

      // 4. Invariants after reload: channel present + usable, state monotonic, no force-close.
      const chans = wallet.getChannelManager()!.list_channels().length;
      if (chans !== 1) gotchas.push({ cycle, kind: "channel-lost-after-restart", detail: `list_channels=${chans}` });

      const v = wallet.getStateVersion();
      if (v < lastStateVersion) gotchas.push({ cycle, kind: "state-version-regressed", detail: `${lastStateVersion} -> ${v}` });
      lastStateVersion = Math.max(lastStateVersion, v);

      await wallet.connectPeer(lspPubkey, "127.0.0.1", 9735);
      for (let i = 0; i < 10 && !(await lndSeesActiveChannel(nodeId)); i++) await sleep(1000);
      if (closeReason) gotchas.push({ cycle, kind: "force-close-on-reestablish", detail: closeReason });
      if (await lndSeesForceClose(nodeId)) gotchas.push({ cycle, kind: "lnd-sees-force-close", detail: "channel in pendingchannels waiting/force-closing" });

      console.log(`[soak] cycle ${cycle}/${SOAK_CYCLES} ok — payments ${paymentsOk}✓/${paymentsFailed}✗, channels=${chans}, stateVer=${v}, gotchas=${gotchas.length}`);
    }

    await wallet.stop();

    console.log(`\n[soak] SUMMARY — payments ${paymentsOk}✓/${paymentsFailed}✗, gotchas=${gotchas.length}`);
    for (const g of gotchas) console.log(`  [GOTCHA] cycle ${g.cycle} :: ${g.kind} :: ${g.detail}`);
    expect(gotchas, `soak found ${gotchas.length} gotcha(s) — see log above`).toEqual([]);
  }, 20 * 60 * 1000);
});
