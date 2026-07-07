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
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import {
  LibreListenerWallet,
  SecureStorageProvider,
  WebSocketStreamProvider,
  WebSocketConnection,
} from "../../index";
import { bytesToHex } from "../../storage-cache";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import * as fs from "fs";
import * as path from "path";
import * as net from "net";
import { execSync, exec } from "child_process";
import { Event } from "lightningdevkit";

const SOAK_CYCLES = parseInt(process.env.SOAK_CYCLES || "8", 10);

function runCmd(cmd: string): string {
  return execSync(cmd, { encoding: "utf8" }).trim();
}
function runCmdAsync(cmd: string): Promise<string> {
  return new Promise((resolve, reject) =>
    exec(cmd, { encoding: "utf8" }, (err, out) => (err ? reject(err) : resolve(out.trim())))
  );
}
function loadWasmBinary(): Uint8Array {
  const paths = [
    path.resolve(__dirname, "../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(__dirname, "../../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "../../node_modules/lightningdevkit/liblightningjs.wasm"),
  ];
  for (const p of paths) if (fs.existsSync(p)) return fs.readFileSync(p);
  throw new Error("Could not find liblightningjs.wasm");
}
class TCPStreamProvider implements WebSocketStreamProvider {
  async connect(address: string, port: number): Promise<WebSocketConnection> {
    const socket = net.connect(port, address);
    const conn: WebSocketConnection = {
      send: (d: Uint8Array) => socket.write(d),
      close: () => socket.destroy(),
    };
    socket.on("data", (d) => conn.onmessage?.(new Uint8Array(d)));
    socket.on("error", (e) => conn.onerror?.(e));
    socket.on("close", () => conn.onclose?.());
    return new Promise((resolve, reject) => {
      socket.once("connect", () => resolve(conn));
      socket.once("error", (e) => reject(e));
    });
  }
}

const BCLI = "docker exec libre-bitcoind bitcoin-cli -regtest -rpcuser=libre -rpcpassword=listener";
const LNCLI = "docker exec libre-lnd lncli --network=regtest";
const MINE_ADDR = "bcrt1qwqp2ru0sx58gpv4fmleuf02wcmu8rs5w93ld6u";
let lspPubkey = "02bdafbf7a60765a9ab4673350c1b5954449e290f498d1ff3a77c58eb7cebfbf24";

const mswServer = setupServer(
  http.get("http://127.0.0.1:3002/blocks/tip/height", () => HttpResponse.text(runCmd(`${BCLI} getblockcount`))),
  http.get("http://127.0.0.1:3002/blocks/tip/hash", () => HttpResponse.text(runCmd(`${BCLI} getbestblockhash`))),
  http.get("http://127.0.0.1:3002/block-height/:height", ({ params }) => HttpResponse.text(runCmd(`${BCLI} getblockhash ${params.height}`))),
  http.get("http://127.0.0.1:3002/block/:hash/header", ({ params }) => HttpResponse.text(runCmd(`${BCLI} getblockheader ${params.hash} false`))),
  http.get("http://127.0.0.1:3002/fee-estimates", () => HttpResponse.json({ "1": 15.0, "6": 8.0, "144": 2.0 })),
);

function makeStorage(db: Map<string, string>): SecureStorageProvider {
  return {
    getItem: async (k) => db.get(k) || null,
    setItem: async (k, v) => { db.set(k, v); },
    removeItem: async (k) => { db.delete(k); },
  };
}
function newWallet(db: Map<string, string>) {
  return new LibreListenerWallet({
    config: { network: "regtest", esploraUrl: "http://127.0.0.1:3002", trustedZeroConfPeers: [lspPubkey] },
    storage: makeStorage(db),
    socketProvider: new TCPStreamProvider(),
    wasmBinary: loadWasmBinary(),
    // Quiet by default; force-close/regression are surfaced via the gotcha collector, not logs.
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A channel force-close fires Event_ChannelClosed. In the node env class names are NOT minified,
// so constructor.name is a reliable discriminator here (unlike the minified PWA — see the
// event-dispatch gotcha).
function attachCloseWatcher(wallet: LibreListenerWallet, onClose: (reason: string) => void): (e: Event) => void {
  const listener = (e: Event) => {
    if (e.constructor.name === "Event_ChannelClosed") {
      let reason = "unknown";
      try { reason = (e as any).reason?.constructor?.name ?? "unknown"; } catch { /* ignore */ }
      onClose(reason);
    }
  };
  wallet.addEventListener(listener);
  return listener;
}

async function lndSeesActiveChannel(nodeId: string): Promise<boolean> {
  try {
    const chan = JSON.parse(runCmd(`${LNCLI} listchannels`)).channels.find((c: any) => c.remote_pubkey === nodeId);
    return !!chan?.active;
  } catch {
    return false;
  }
}
async function lndSeesForceClose(nodeId: string): Promise<boolean> {
  try {
    const pending = JSON.parse(runCmd(`${LNCLI} pendingchannels`));
    const waiting = [...(pending.waiting_close_channels || []), ...(pending.pending_force_closing_channels || [])];
    return waiting.some((c: any) => c.channel?.remote_node_pub === nodeId);
  } catch {
    return false;
  }
}

interface Gotcha { cycle: number; kind: string; detail: string }

describe("SOAK: restart + payments must not reset/force-close the channel", () => {
  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: "bypass" });
    try { runCmd(`${BCLI} generatetoaddress 1 ${MINE_ADDR}`); } catch { /* ignore */ }
    for (let i = 0; i < 30; i++) {
      try {
        const info = JSON.parse(runCmd(`${LNCLI} getinfo`));
        if (info.identity_pubkey) lspPubkey = info.identity_pubkey;
        if (info.synced_to_chain) break;
      } catch { /* retry */ }
      await sleep(1000);
    }
  }, 60000);
  afterEach(() => mswServer.resetHandlers());
  afterAll(() => mswServer.close());

  it(`survives ${SOAK_CYCLES} pay+restart cycles with no force-close or state reset`, async () => {
    const gotchas: Gotcha[] = [];
    const db = new Map<string, string>();

    // --- Setup: open one channel (lnd -> wallet, zero-conf) and fund the wallet a bit ---
    let wallet = newWallet(db);
    let closeReason: string | null = null;
    let watcher = attachCloseWatcher(wallet, (r) => { closeReason = r; });
    let channelReady = false;
    const readyListener = (e: Event) => { if (e.constructor.name === "Event_ChannelReady") channelReady = true; };
    wallet.addEventListener(readyListener);

    await wallet.start();
    const nodeId = bytesToHex(wallet.getChannelManager()!.get_our_node_id());
    await wallet.connectPeer(lspPubkey, "127.0.0.1", 9735);
    await sleep(2000);

    const openPromise = runCmdAsync(
      `${LNCLI} openchannel --node_key ${nodeId} --local_amt 1000000 --push_amt 200000 --zero_conf --private --channel_type anchors`,
    ).catch(() => {});
    for (let i = 0; i < 40 && !channelReady; i++) await sleep(500);
    expect(channelReady, "channel never became ready in setup").toBe(true);
    wallet.removeEventListener(readyListener);
    for (let i = 0; i < 20 && !(await lndSeesActiveChannel(nodeId)); i++) await sleep(1000);
    await openPromise;
    await sleep(3000);

    const initialChannels = wallet.getChannelManager()!.list_channels().length;
    expect(initialChannels, "expected exactly one channel after setup").toBe(1);
    let lastStateVersion = wallet.getStateVersion();

    // --- Soak loop: pay (alternating send/receive) then restart on the SAME storage ---
    let paymentsOk = 0;
    let paymentsFailed = 0;
    for (let cycle = 1; cycle <= SOAK_CYCLES; cycle++) {
      closeReason = null;

      // 1. A small payment to advance channel state (the load that precedes the reset).
      try {
        if (cycle % 2 === 1) {
          // Send: keysend boost to lnd (the V4V path).
          const res = await wallet.sendKeysendPayment({
            destinationPubkey: lspPubkey,
            amountSats: 300,
            customRecords: { 7629169: JSON.stringify({ action: "boost", app_name: "libre-soak" }) },
          });
          if (res.ok) paymentsOk++; else { paymentsFailed++; gotchas.push({ cycle, kind: "send-failed", detail: res.error || "unknown" }); }
        } else {
          // Receive: wallet invoices, lnd pays it.
          const invoice = await wallet.createInvoice(200, "soak-receive");
          const pay = runCmdAsync(`${LNCLI} payinvoice --force --pay_req ${invoice}`).catch(() => "");
          await pay;
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

      wallet = newWallet(db);
      closeReason = null;
      watcher = attachCloseWatcher(wallet, (r) => { closeReason = r; });

      // 3. start() may THROW ChannelStateRegressionError — that's the guard HALTING on a detected
      //    reset (the SAFE outcome, but we record it as a caught reset so a long soak reveals it).
      try {
        await wallet.start();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        gotchas.push({ cycle, kind: msg.includes("CHANNEL_STATE_REGRESSION") ? "regression-halt-on-restart" : "start-threw", detail: msg });
        break; // node won't run; stop the soak and report
      }

      // 4. Invariants after reload: channel present + usable, state monotonic, no force-close.
      const chans = wallet.getChannelManager()!.list_channels().length;
      if (chans !== 1) gotchas.push({ cycle, kind: "channel-lost-after-restart", detail: `list_channels=${chans}` });

      const v = wallet.getStateVersion();
      if (v < lastStateVersion) gotchas.push({ cycle, kind: "state-version-regressed", detail: `${lastStateVersion} -> ${v}` });
      lastStateVersion = Math.max(lastStateVersion, v);

      await wallet.connectPeer(lspPubkey, "127.0.0.1", 9735);
      // Give reconnect + reestablish a moment; a data-loss reestablish would force-close here.
      for (let i = 0; i < 10 && !(await lndSeesActiveChannel(nodeId)); i++) await sleep(1000);
      if (closeReason) gotchas.push({ cycle, kind: "force-close-on-reestablish", detail: closeReason });
      if (await lndSeesForceClose(nodeId)) gotchas.push({ cycle, kind: "lnd-sees-force-close", detail: "channel in pendingchannels waiting/force-closing" });
      console.log(`[soak] cycle ${cycle}/${SOAK_CYCLES} ok — payments ${paymentsOk}✓/${paymentsFailed}✗, channels=${chans}, stateVer=${v}, gotchas=${gotchas.length}`);
    }

    await wallet.stop();

    // --- Report ---
    console.log(`\n[soak] SUMMARY — cycles run, payments ${paymentsOk}✓/${paymentsFailed}✗, gotchas=${gotchas.length}`);
    for (const g of gotchas) {
      console.log(`  [GOTCHA] cycle ${g.cycle} :: ${g.kind} :: ${g.detail}`);
    }
    expect(gotchas, `soak found ${gotchas.length} gotcha(s) — see log above`).toEqual([]);
  }, 20 * 60 * 1000); // up to 20 min; scale the vitest hookTimeout / SOAK_CYCLES for longer runs
});
