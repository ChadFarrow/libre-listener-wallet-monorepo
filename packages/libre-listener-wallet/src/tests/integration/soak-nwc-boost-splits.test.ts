// @vitest-environment node
//
// SOAK: the V4V boost SPLIT fan-out through real NWC. A single boost fans out into SPLITS_PER_BOOST
// keysends (bLIP-10 TLV: shared boost_uuid, unique uuid per recipient), fired concurrently through
// the wallet's real NwcManager (pay_keysend). This is the workload a v4vmusic boost actually
// generates — many rapid in-flight HTLCs churning channel state — and then the wallet is RESTARTED,
// asserting the channel survives with no force-close. Also verifies each split arrives at lnd
// carrying the SHARED boost_uuid (the split-semantics invariant).
//
// In regtest all splits land at the one channel peer (libre-lnd); a real boost fans out to many
// nodes, but the local stress — N rapid keysends per boost, then a reload — is the same.
//
// Run locally (Mac):
//   docker compose up -d
//   BOOST_CYCLES=5 SPLITS_PER_BOOST=6 pnpm --filter @libre/listener-wallet exec vitest run \
//     src/tests/integration/soak-nwc-boost-splits.test.ts
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
  runCmd,
  LNCLI,
} from "./soak-harness";
import { startNostrTestRelay, NostrTestRelay } from "./nostr-test-relay";
import { connectNwcClient, NwcClient } from "./nwc-test-client";

const BOOST_CYCLES = parseInt(process.env.BOOST_CYCLES || "3", 10);
const SPLITS_PER_BOOST = parseInt(process.env.SPLITS_PER_BOOST || "4", 10);
const SPLIT_SATS = 10;
const FEED_GUID = "libre-boost-soak-feed";

interface Gotcha { cycle: number; kind: string; detail: string }

const mswServer = createEsploraMsw();
let lspPubkey = "";
let relay: NostrTestRelay;

// bLIP-10 boost record for one split. boost_uuid is shared across the boost; uuid is per-recipient.
function boostTlvHex(boostUuid: string, recipientIndex: number): string {
  const record = {
    action: "boost",
    app_name: "libre-boost-soak",
    value_msat_total: SPLIT_SATS * SPLITS_PER_BOOST * 1000,
    boost_uuid: boostUuid,
    uuid: `${boostUuid}:${recipientIndex}`,
    name: `recipient-${recipientIndex}`,
    feedGuid: FEED_GUID,
  };
  return Buffer.from(JSON.stringify(record)).toString("hex");
}

// Count settled keysend invoices at lnd (created after `preAddIndex`) whose 7629169 boost record
// carries the given boost_uuid — i.e. how many splits of THIS boost actually arrived.
function countArrivedSplits(boostUuid: string, preAddIndex: number): number {
  let count = 0;
  try {
    const invoices = JSON.parse(runCmd(`${LNCLI} listinvoices`)).invoices || [];
    for (const inv of invoices) {
      if (!(inv.is_keysend && (inv.state === "SETTLED" || inv.settled === true))) continue;
      if (Number(inv.add_index) <= preAddIndex) continue;
      const cr: Record<string, string> = inv.htlcs?.[0]?.custom_records || {};
      const boostHex = cr["7629169"];
      if (!boostHex) continue;
      try {
        const rec = JSON.parse(Buffer.from(boostHex, "hex").toString("utf8"));
        if (rec.boost_uuid === boostUuid) count++;
      } catch { /* not our record */ }
    }
  } catch { /* lnd query failed; treat as 0 */ }
  return count;
}

function maxAddIndex(): number {
  try {
    const invoices = JSON.parse(runCmd(`${LNCLI} listinvoices`)).invoices || [];
    return invoices.reduce((m: number, inv: any) => Math.max(m, Number(inv.add_index) || 0), 0);
  } catch {
    return 0;
  }
}

describe("SOAK: V4V boost split fan-out via NWC + restart must not force-close", () => {
  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: "bypass" });
    lspPubkey = await waitForLndSynced(lspPubkey);
    relay = await startNostrTestRelay();
  }, 60000);
  afterEach(() => mswServer.resetHandlers());
  afterAll(async () => { mswServer.close(); await relay.close(); });

  it(`survives ${BOOST_CYCLES} boosts of ${SPLITS_PER_BOOST} splits each, with restarts`, async () => {
    const gotchas: Gotcha[] = [];
    const db = new Map<string, string>();

    let wallet = newWallet(db, { lspPubkey });
    let closeReason: string | null = null;
    let watcher = attachCloseWatcher(wallet, (r) => { closeReason = r; });
    await wallet.start();
    const nodeId = bytesToHex(wallet.getChannelManager()!.get_our_node_id());
    await openZeroConfChannelToWallet(wallet, nodeId, lspPubkey, { localAmtSat: 1000000, pushAmtSat: 300000 });
    expect(wallet.getChannelManager()!.list_channels().length, "one channel after setup").toBe(1);

    const pairingUri = await wallet.nwc.createConnection("boost-soak", { relayUrl: relay.url, spendingLimitSats: 0 });
    const client: NwcClient = await connectNwcClient(pairingUri);
    await sleep(2000);

    let splitsOk = 0;
    for (let cycle = 1; cycle <= BOOST_CYCLES; cycle++) {
      closeReason = null;
      const boostUuid = crypto.randomUUID();
      const preAddIndex = maxAddIndex();

      // 1. Fan out the boost: SPLITS_PER_BOOST concurrent pay_keysend requests (the wallet serializes
      //    them per-client, but they churn channel state in rapid succession — the real boost load).
      const results = await Promise.all(
        Array.from({ length: SPLITS_PER_BOOST }, (_, i) =>
          client
            .request("pay_keysend", {
              pubkey: lspPubkey,
              amount: SPLIT_SATS * 1000,
              tlv_records: [
                { type: 7629169, value: boostTlvHex(boostUuid, i) },
                { type: 7629175, value: Buffer.from(FEED_GUID).toString("hex") },
              ],
            })
            .catch((e) => ({ error: { code: "THREW", message: e instanceof Error ? e.message : String(e) } })),
        ),
      );
      results.forEach((resp, i) => {
        if (resp.error) gotchas.push({ cycle, kind: "split-failed", detail: `split ${i}: ${resp.error.code}: ${resp.error.message}` });
        else if (!(resp as any).result?.preimage) gotchas.push({ cycle, kind: "split-no-preimage", detail: `split ${i}` });
        else splitsOk++;
      });
      await sleep(2000);
      if (closeReason) gotchas.push({ cycle, kind: "force-close-during-boost", detail: closeReason });

      // 2. Verify the split semantics: all splits arrived at lnd carrying the SHARED boost_uuid.
      const arrived = countArrivedSplits(boostUuid, preAddIndex);
      if (arrived !== SPLITS_PER_BOOST) {
        gotchas.push({ cycle, kind: "split-count-mismatch", detail: `boost_uuid ${boostUuid}: ${arrived}/${SPLITS_PER_BOOST} arrived` });
      }

      // 3. RESTART on the same storage.
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

      const chans = wallet.getChannelManager()!.list_channels().length;
      if (chans !== 1) gotchas.push({ cycle, kind: "channel-lost-after-restart", detail: `list_channels=${chans}` });
      await wallet.connectPeer(lspPubkey, "127.0.0.1", 9735);
      for (let i = 0; i < 12 && !(await lndSeesActiveChannel(nodeId)); i++) await sleep(1000);
      if (closeReason) gotchas.push({ cycle, kind: "force-close-on-reestablish", detail: closeReason });
      if (await lndSeesForceClose(nodeId)) gotchas.push({ cycle, kind: "lnd-sees-force-close", detail: "channel in pendingchannels" });
      await sleep(2000); // let the restarted NwcManager re-subscribe before the next boost

      console.log(`[boost-soak] cycle ${cycle}/${BOOST_CYCLES} — splits ${splitsOk}✓, arrived ${arrived}/${SPLITS_PER_BOOST}, channels=${chans}, gotchas=${gotchas.length}`);
    }

    await client.close();
    await wallet.stop();

    console.log(`\n[boost-soak] SUMMARY — splits ${splitsOk}✓ over ${BOOST_CYCLES} boosts, gotchas=${gotchas.length}`);
    for (const g of gotchas) console.log(`  [GOTCHA] cycle ${g.cycle} :: ${g.kind} :: ${g.detail}`);
    expect(gotchas, `boost-split soak found ${gotchas.length} gotcha(s) — see log above`).toEqual([]);
  }, 30 * 60 * 1000);
});
