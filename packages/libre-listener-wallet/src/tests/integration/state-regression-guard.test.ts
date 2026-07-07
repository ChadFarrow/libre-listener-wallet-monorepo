// @vitest-environment node
//
// Proves the channel-state regression guard: after a channel is funded and the wallet has
// recorded a monitor-update high-water, a wallet that reloads with a high-water ABOVE the
// loaded monitor's update id (a durable-state regression) refuses to start — instead of
// reconnecting and being force-closed. Requires `docker compose up -d`.
//
// (Preamble — runCmd/loadWasmBinary/TCPStreamProvider/mswServer/fundChannel — adapted from
// recovery.test.ts's "Wallet recovery after storage wipe" harness.)
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import {
  LibreListenerWallet,
  SecureStorageProvider,
  WebSocketStreamProvider,
  WebSocketConnection,
  ChannelStateRegressionError,
} from "../../index";
import { bytesToHex } from "../../storage-cache";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import * as fs from "fs";
import * as path from "path";
import * as net from "net";
import { execSync, exec } from "child_process";
import { Event, Event_ChannelReady, Event_PaymentClaimable } from "lightningdevkit";

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
  http.get("http://127.0.0.1:3002/fee-estimates", () => HttpResponse.json({ "1": 15.0, "6": 8.0, "144": 2.0 }))
);

function makeStorage(db: Map<string, string>): SecureStorageProvider {
  return {
    getItem: async (k) => db.get(k) || null,
    setItem: async (k, v) => { db.set(k, v); },
    removeItem: async (k) => { db.delete(k); },
  };
}
function makeWalletOverStorage(db: Map<string, string>): LibreListenerWallet {
  return new LibreListenerWallet({
    // The regtest LND is the trusted LSP here, so allow its 0-conf JIT channel.
    config: { network: "regtest", esploraUrl: "http://127.0.0.1:3002", trustedZeroConfPeers: [lspPubkey] },
    storage: makeStorage(db),
    socketProvider: new TCPStreamProvider(),
    wasmBinary: loadWasmBinary(),
    logger: { info: () => {}, warn: () => {}, error: (m, ...a) => console.error(`[ERROR] ${m}`, ...a) },
  });
}

// Opens + confirms a real zero-conf channel from libre-lnd to a fresh wallet over `db`, has LND
// pay one invoice over it (so the ChannelMonitor's update id actually advances past 0 — opening
// alone doesn't produce a commitment update), then restarts a fresh wallet instance over the
// SAME storage.
//
// The regression guard only advances/persists `monitor_update_highwater` for channels whose
// monitor was already loaded from storage AT start() time (`advanceMonitorHighwater` only
// covers `this.loadedMonitors`, i.e. channels present at start — a channel opened mid-session
// is picked up "on the next start when their monitors load", per index.ts). So a channel opened
// during this session won't get a high-water entry until we actually restart — which is exactly
// the real-world sequence this guard defends (browser reload / node restart), so restarting here
// is faithful, not a workaround. Returns the SECOND (restarted) wallet instance, started.
async function fundChannel(db: Map<string, string>): Promise<LibreListenerWallet> {
  const walletA = makeWalletOverStorage(db);
  let channelReady = false;
  let paymentClaimed = false;
  const listener = (e: Event) => {
    if (e instanceof Event_ChannelReady) channelReady = true;
    else if (e instanceof Event_PaymentClaimable) paymentClaimed = true;
  };
  walletA.addEventListener(listener);
  await walletA.start();
  const nodeId = bytesToHex(walletA.getChannelManager()!.get_our_node_id());
  await walletA.connectPeer(lspPubkey, "127.0.0.1", 9735);
  await new Promise((r) => setTimeout(r, 2000));

  const openPromise = runCmdAsync(
    `${LNCLI} openchannel --node_key ${nodeId} --local_amt 500000 --zero_conf --private --channel_type anchors`
  ).catch(() => {});
  for (let i = 0; i < 30 && !channelReady; i++) await new Promise((r) => setTimeout(r, 500));
  expect(channelReady).toBe(true);
  await openPromise;
  await new Promise((r) => setTimeout(r, 3000)); // let post-ready sync settle

  // LND pays an invoice from our wallet: this is a real HTLC add + commitment update, which
  // bumps the channel's monitor update id off 0.
  const invoice = await walletA.createInvoice(20000, "state-regression-guard fixture");
  const payPromise = runCmdAsync(`${LNCLI} payinvoice --force --pay_req ${invoice}`).catch(() => {});
  for (let i = 0; i < 30 && !paymentClaimed; i++) await new Promise((r) => setTimeout(r, 500));
  expect(paymentClaimed).toBe(true);
  await payPromise;
  await new Promise((r) => setTimeout(r, 3000)); // let the monitor update persist

  walletA.removeEventListener(listener);
  await walletA.stop();

  // Restart over the same storage: the guard's start-time merge now sees the persisted monitor
  // (with a real, non-zero update id) and writes it as the high-water (before any peer dial).
  const walletB = makeWalletOverStorage(db);
  await walletB.start();
  return walletB;
}

describe("regression guard (integration)", () => {
  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: "bypass" });
    try {
      runCmd(`${BCLI} generatetoaddress 1 ${MINE_ADDR}`);
    } catch {
      /* ignore */
    }
    for (let i = 0; i < 30; i++) {
      try {
        const info = JSON.parse(runCmd(`${LNCLI} getinfo`));
        if (info.identity_pubkey) lspPubkey = info.identity_pubkey;
        if (info.synced_to_chain) break;
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }, 60000);
  afterEach(() => mswServer.resetHandlers());
  afterAll(() => mswServer.close());

  it("halts start() when the high-water is ahead of the loaded monitor", async () => {
    const HW_KEY = "monitor_update_highwater";

    // 1. Bring up a funded wallet over an in-memory storage Map, open a channel to the LSP/lnd,
    //    let it sync so the monitor persists and the high-water advances.
    const db = new Map<string, string>();
    const wallet = await fundChannel(db);
    // sanity: the guard recorded a high-water for the channel
    const rawHw = db.get(HW_KEY);
    expect(rawHw).toBeTruthy();
    const recorded = JSON.parse(rawHw!) as Record<string, string>;
    const entries = Object.entries(recorded);
    expect(entries.length).toBeGreaterThan(0);
    const [channelId, updateIdStr] = entries[0];
    expect(BigInt(updateIdStr)).toBeGreaterThan(0n);
    await wallet.stop();

    // 2. Simulate a durable regression: the monitor blob on disk is now BEHIND the high-water.
    //    Bump the stored high-water above the monitor's real update id (equivalent to the
    //    monitor blob rolling back below the mark).
    recorded[channelId] = (BigInt(updateIdStr) + 5n).toString();
    db.set(HW_KEY, JSON.stringify(recorded));

    // 3. A new wallet over the same storage must REFUSE to start.
    const revived = makeWalletOverStorage(db);
    await expect(revived.start()).rejects.toBeInstanceOf(ChannelStateRegressionError);
    expect(revived.status()).not.toBe("Running");
  }, 120_000);
});
