// @vitest-environment node
//
// SOAK: the "used anywhere, on and off" hazard — the SAME wallet (seed) handed between devices via
// VSS, where a device RESUMES with STALE-but-present local state after another device moved the
// channel forward. The device lease stops two devices running AT ONCE, but not this SEQUENTIAL case:
//   A runs → advances channel → stops (mirrors to VSS)
//   B (same seed, own storage) starts → re-hydrates A's state from VSS → advances FURTHER → stops
//   A RESUMES with its old local channel_manager → must NOT reconnect stale (→ force-close); it must
//   pick up B's newer state (or halt) instead.
// Two separate storages = two devices; one shared in-process VSS store (same seed → same store).
//
//   docker compose up -d
//   pnpm --filter @libre/listener-wallet exec vitest run \
//     src/tests/integration/soak-crossdevice-handoff.test.ts
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
} from "./soak-harness";
import { startVssTestServer, VssTestServer } from "./vss-test-server";
import { deriveVssStoreId } from "../../index";
import { decryptAndParse } from "../../state-backup";

const SEED = "22".repeat(32); // both "devices" share this seed (same wallet)

const mswServer = createEsploraMsw();
let lspPubkey = "";
let vss: VssTestServer;

interface Gotcha { phase: string; kind: string; detail: string }

describe("SOAK: cross-device handoff — resuming with stale local state must not force-close", () => {
  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: "bypass" });
    lspPubkey = await waitForLndSynced(lspPubkey);
    vss = await startVssTestServer();
  }, 60000);
  afterEach(() => mswServer.resetHandlers());
  afterAll(async () => { mswServer.close(); await vss.close(); }, 30000);

  // SKIPPED: documents a KNOWN LIMITATION, not a passing test. Copying live LDK channel state
  // (channel_manager + monitors) onto a device that ALREADY holds stale state for the same channel
  // does not cleanly reconstruct it — the monitors don't replace over the old ones, so on reconnect
  // LDK sends a "bogus ChannelReestablish ... to force channel closure" (verified in the logs). LDK
  // is not designed to hand a live channel between running node instances by state-copy. The safe
  // multi-device pattern is ONE always-on node + other devices as NWC CLIENTS. The device LEASE
  // still prevents the dangerous SIMULTANEOUS-use collision, and VSS re-hydrates a device that lost
  // its storage entirely (empty-local) — both of which DO work. Un-skip to iterate on active handoff.
  it.skip("device A → B (advances) → A resumes: channel survives, no force-close", async () => {
    const gotchas: Gotcha[] = [];
    const dbA = new Map<string, string>([["ldk_seed", SEED]]);
    const dbB = new Map<string, string>([["ldk_seed", SEED]]);

    const pay = async (w: any, n: number) => {
      const r = await w.sendKeysendPayment({
        destinationPubkey: lspPubkey,
        amountSats: 50,
        customRecords: { 7629169: JSON.stringify({ action: "stream", app_name: "handoff", n }) },
      });
      return r.ok;
    };

    const storeId = await deriveVssStoreId(SEED);
    const diagVss = async (label: string) => {
      const blob = vss.getValue(storeId, "state_backup");
      if (!blob) { console.log(`[handoff][DIAG] ${label}: NO state_backup in VSS`); return; }
      try {
        const p = await decryptAndParse(new TextDecoder().decode(blob), SEED);
        const keys = Object.keys(p.entries ?? {});
        console.log(`[handoff][DIAG] ${label}: blob ${blob.length}b, channel_manager=${p.entries?.channel_manager?.length ?? 0}b, state_version=${p.entries?.state_version}, monitorKeys=${keys.filter((k) => k.startsWith("monitors/")).length}`);
      } catch (e) { console.log(`[handoff][DIAG] ${label}: decode failed ${e instanceof Error ? e.message : e}`); }
    };

    // ---- Phase 1: device A opens the channel + advances state, then stops (mirrors final to VSS) ----
    let a = newWallet(dbA, { lspPubkey, vssUrl: vss.url, quiet: false });
    let aClose: string | null = null;
    let aWatch = attachCloseWatcher(a, (r) => { aClose = r; });
    await a.start();
    const nodeId = bytesToHex(a.getChannelManager()!.get_our_node_id());
    await openZeroConfChannelToWallet(a, nodeId, lspPubkey, { localAmtSat: 2000000, pushAmtSat: 800000 });
    for (let i = 0; i < 3; i++) { if (!(await pay(a, i))) gotchas.push({ phase: "A1", kind: "pay-failed", detail: `#${i}` }); await sleep(800); }
    const aVer1 = a.getStateVersion();
    await sleep(6000); // let the debounced VSS mirror upload A's latest state
    await diagVss("after A payments (pre-stop)");
    a.removeEventListener(aWatch);
    await a.stop();
    await diagVss("after A stop");
    console.log(`[handoff] A ran to stateVersion=${aVer1}, stopped (mirrored to VSS)`);

    // ---- Phase 2: device B (fresh storage, same seed) picks up via VSS + advances FURTHER ----
    let b = newWallet(dbB, { lspPubkey, vssUrl: vss.url, quiet: false });
    let bClose: string | null = null;
    const bWatch = attachCloseWatcher(b, (r) => { bClose = r; });
    await b.start();
    const bChans = b.getChannelManager()!.list_channels().length;
    if (bChans !== 1) gotchas.push({ phase: "B", kind: "not-rehydrated", detail: `channels=${bChans}` });
    await b.connectPeer(lspPubkey, "127.0.0.1", 9735);
    for (let i = 0; i < 12 && !(await lndSeesActiveChannel(nodeId)); i++) await sleep(1000);
    for (let i = 0; i < 4; i++) { if (!(await pay(b, i))) gotchas.push({ phase: "B", kind: "pay-failed", detail: `#${i}` }); await sleep(800); }
    const bVer = b.getStateVersion();
    if (bClose) gotchas.push({ phase: "B", kind: "force-close", detail: bClose });
    await sleep(6000); // let B's newer state mirror to VSS
    b.removeEventListener(bWatch);
    await b.stop();
    console.log(`[handoff] B re-hydrated + advanced to stateVersion=${bVer}, stopped`);

    // ---- Phase 3: device A RESUMES with its now-STALE local state (still has phase-1 channel_manager) ----
    await diagVss("before A resume (VSS should hold B's newer state)");
    console.log(`[handoff][DIAG] dbA local: channel_manager=${dbA.has("channel_manager")}, state_version=${dbA.get("state_version")}`);
    a = newWallet(dbA, { lspPubkey, vssUrl: vss.url, quiet: false });
    aClose = null;
    aWatch = attachCloseWatcher(a, (r) => { aClose = r; });
    try {
      await a.start();
    } catch (e) {
      // A HALT here (regression/stale detected) is the SAFE outcome — better than a force-close.
      gotchas.push({ phase: "A-resume", kind: "start-halted", detail: e instanceof Error ? e.message : String(e) });
    }
    if (a.status() === "Running") {
      await a.connectPeer(lspPubkey, "127.0.0.1", 9735);
      await sleep(6000); // give the reestablish time to (mis)fire
      if (aClose) gotchas.push({ phase: "A-resume", kind: "force-close-on-reestablish", detail: aClose });
      if (await lndSeesForceClose(nodeId)) gotchas.push({ phase: "A-resume", kind: "lnd-sees-force-close", detail: "channel in pendingchannels" });
      await a.stop().catch(() => {});
    }

    console.log(`\n[handoff] SUMMARY — gotchas=${gotchas.length}`);
    for (const g of gotchas) console.log(`  [GOTCHA] ${g.phase} :: ${g.kind} :: ${g.detail}`);
    // A force-close is the failure we're hunting. A safe HALT (start-halted) is acceptable — it sends
    // the user to recover rather than losing the channel — so we only fail on an actual force-close.
    const fatal = gotchas.filter((g) => g.kind.includes("force-close") || g.kind === "not-rehydrated" || g.kind === "pay-failed");
    expect(fatal, `handoff soak found ${fatal.length} fatal gotcha(s) — see log`).toEqual([]);
  }, 20 * 60 * 1000);
});
