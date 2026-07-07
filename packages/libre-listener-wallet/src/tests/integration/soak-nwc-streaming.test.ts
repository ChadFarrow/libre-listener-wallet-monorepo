// @vitest-environment node
//
// SOAK: sustained "streaming sats" load through the REAL NWC flow — the V4V workload where an app
// keysends small amounts on a timer (e.g. ~10/min while a track plays). Unlike the restart soak,
// this keeps ONE wallet up and fires keysends at a fixed RATE for many payments, measuring each
// payment's success + latency to find where/why streaming degrades (relay throughput, per-client
// serialization backpressure, HTLC-slot/liquidity limits, mirror/lease overhead). Reports every
// failing payment (# + error) and latency stats so a long stream surfaces the breaking point.
//
// Run locally (Mac):
//   docker compose up -d
//   # realistic: 10/min for 30 payments (~3 min)
//   STREAM_PAYMENTS=30 STREAM_INTERVAL_MS=6000 pnpm --filter @libre/listener-wallet exec vitest run \
//     src/tests/integration/soak-nwc-streaming.test.ts
//   # stress: as fast as it'll go
//   STREAM_PAYMENTS=100 STREAM_INTERVAL_MS=500 pnpm --filter @libre/listener-wallet exec vitest run ...
//   # mid-stream reloads: restart the wallet every N payments
//   STREAM_RESTART_EVERY=20 ...
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { bytesToHex } from "../../storage-cache";
import {
  createEsploraMsw,
  waitForLndSynced,
  newWallet,
  attachCloseWatcher,
  lndSeesForceClose,
  openZeroConfChannelToWallet,
  sleep,
} from "./soak-harness";
import { startNostrTestRelay, NostrTestRelay } from "./nostr-test-relay";
import { connectNwcClient, NwcClient } from "./nwc-test-client";

const PAYMENTS = parseInt(process.env.STREAM_PAYMENTS || "30", 10);
const INTERVAL_MS = parseInt(process.env.STREAM_INTERVAL_MS || "6000", 10); // 6s ≈ 10/min (peak ~20/min)
const AMOUNT_SATS = parseInt(process.env.STREAM_AMOUNT_SATS || "10", 10);
const RESTART_EVERY = parseInt(process.env.STREAM_RESTART_EVERY || "0", 10); // 0 = never restart
// A real V4V boost fired DURING streaming: a burst of CONCURRENT split keysends on top of the steady
// stream (all serialized through the one NWC pairing). Rare but the heaviest churn. 0 = no boosts.
const BOOST_EVERY = parseInt(process.env.STREAM_BOOST_EVERY || "0", 10);
const BOOST_SPLITS = parseInt(process.env.STREAM_BOOST_SPLITS || "6", 10);

interface Failure { n: number; kind: string; detail: string }

const mswServer = createEsploraMsw();
let lspPubkey = "";
let relay: NostrTestRelay;

const boostTlvHex = (n: number) =>
  Buffer.from(JSON.stringify({ action: "stream", app_name: "libre-stream-soak", ts: n })).toString("hex");

describe("SOAK: sustained NWC streaming-sats load (no force-close, payments keep landing)", () => {
  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: "bypass" });
    lspPubkey = await waitForLndSynced(lspPubkey);
    relay = await startNostrTestRelay();
  }, 60000);
  afterEach(() => mswServer.resetHandlers());
  afterAll(async () => { mswServer.close(); await relay.close(); }, 30000);

  it(`streams ${PAYMENTS} keysends @ ${Math.round(60000 / INTERVAL_MS)}/min without failure or force-close`, async () => {
    const failures: Failure[] = [];
    const latencies: number[] = [];
    const db = new Map<string, string>();

    let wallet = newWallet(db, { lspPubkey });
    let closeReason: string | null = null;
    let watcher = attachCloseWatcher(wallet, (r) => { closeReason = r; });
    await wallet.start();
    const nodeId = bytesToHex(wallet.getChannelManager()!.get_our_node_id());
    // A big local balance so liquidity isn't the limiter — we're testing RATE/reliability.
    await openZeroConfChannelToWallet(wallet, nodeId, lspPubkey, { localAmtSat: 3000000, pushAmtSat: 1500000 });
    expect(wallet.getChannelManager()!.list_channels().length, "one channel after setup").toBe(1);

    const pairingUri = await wallet.nwc.createConnection("stream", { relayUrl: relay.url, spendingLimitSats: 0 });
    let client: NwcClient = await connectNwcClient(pairingUri);
    await sleep(2000);

    let ok = 0;
    for (let n = 1; n <= PAYMENTS; n++) {
      const started = Date.now();
      try {
        const resp = await client.request("pay_keysend", {
          pubkey: lspPubkey,
          amount: AMOUNT_SATS * 1000,
          tlv_records: [{ type: 7629169, value: boostTlvHex(n) }],
        });
        const latency = Date.now() - started;
        latencies.push(latency);
        if (resp.error) failures.push({ n, kind: "nwc-error", detail: `${resp.error.code}: ${resp.error.message}` });
        else if (!resp.result?.preimage) failures.push({ n, kind: "no-preimage", detail: JSON.stringify(resp) });
        else ok++;
      } catch (e) {
        failures.push({ n, kind: "threw", detail: e instanceof Error ? e.message : String(e) });
      }
      if (closeReason) { failures.push({ n, kind: "force-close", detail: closeReason }); break; }

      // Optional BOOST during the stream: a burst of BOOST_SPLITS extra keysends paid ONE AT A TIME
      // (V4V apps pay splits sequentially, not all at once) with no gap between them — on top of the
      // steady stream. The rare but heaviest churn a listener generates.
      if (BOOST_EVERY > 0 && n % BOOST_EVERY === 0) {
        const boostStarted = Date.now();
        let boostOk = 0;
        for (let s = 0; s < BOOST_SPLITS; s++) {
          try {
            const r = await client.request("pay_keysend", {
              pubkey: lspPubkey,
              amount: AMOUNT_SATS * 1000,
              tlv_records: [{ type: 7629169, value: boostTlvHex(n * 1000 + s) }],
            });
            if (r.error) failures.push({ n, kind: "boost-split-error", detail: `split ${s}: ${r.error.code}: ${r.error.message}` });
            else if (!r.result?.preimage) failures.push({ n, kind: "boost-split-no-preimage", detail: `split ${s}` });
            else { boostOk++; ok++; }
          } catch (e) {
            failures.push({ n, kind: "boost-split-threw", detail: `split ${s}: ${e instanceof Error ? e.message : String(e)}` });
          }
          if (closeReason) { failures.push({ n, kind: "force-close-during-boost", detail: closeReason }); break; }
        }
        console.log(`[stream-soak] boost @ ${n}: ${boostOk}/${BOOST_SPLITS} splits ok in ${Date.now() - boostStarted}ms`);
        if (closeReason) break;
      }

      // Optional mid-stream reload (a real listener might refresh the page while streaming).
      if (RESTART_EVERY > 0 && n % RESTART_EVERY === 0 && n < PAYMENTS) {
        wallet.removeEventListener(watcher);
        await wallet.stop();
        wallet = newWallet(db, { lspPubkey });
        closeReason = null;
        watcher = attachCloseWatcher(wallet, (r) => { closeReason = r; });
        try { await wallet.start(); } catch (e) { failures.push({ n, kind: "restart-threw", detail: e instanceof Error ? e.message : String(e) }); break; }
        await wallet.connectPeer(lspPubkey, "127.0.0.1", 9735);
        await sleep(3000); // let the NwcManager re-subscribe before the next request
      }

      const elapsed = Date.now() - started;
      if (elapsed < INTERVAL_MS) await sleep(INTERVAL_MS - elapsed);

      if (n % 10 === 0 || n === PAYMENTS) {
        const bal = wallet.getBalance();
        console.log(`[stream-soak] ${n}/${PAYMENTS} — ok=${ok}, fails=${failures.length}, spendable=${bal.spendableSat}sat`);
      }
    }

    if (await lndSeesForceClose(nodeId)) failures.push({ n: PAYMENTS, kind: "lnd-sees-force-close", detail: "channel in pendingchannels" });
    await client.close().catch(() => {});
    await wallet.stop();

    const stat = latencies.length
      ? { min: Math.min(...latencies), max: Math.max(...latencies), avg: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) }
      : { min: 0, max: 0, avg: 0 };
    console.log(`\n[stream-soak] SUMMARY — ${ok}/${PAYMENTS} ok, ${failures.length} failures; latency ms min/avg/max = ${stat.min}/${stat.avg}/${stat.max}`);
    for (const f of failures) console.log(`  [FAIL] payment ${f.n} :: ${f.kind} :: ${f.detail}`);
    expect(failures, `streaming soak: ${failures.length} failure(s) — see log`).toEqual([]);
  }, 30 * 60 * 1000);
});
