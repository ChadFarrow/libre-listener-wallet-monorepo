// @vitest-environment node
//
// Proves an IndexedDB wipe cannot lose funds: a funded wallet exports its encrypted
// state, a brand-new empty wallet imports it, and the recovered wallet still controls
// the channel AND can send a keysend boost the podcaster (LND) receives.
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
import { Event, Event_PaymentClaimable } from "lightningdevkit";

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
const lspApiUrl = "http://127.0.0.1:9099/lsps2";
let mockJitScid = "1234567890123456";
let lspPubkey = "02bdafbf7a60765a9ab4673350c1b5954449e290f498d1ff3a77c58eb7cebfbf24";

const mswServer = setupServer(
  http.get("http://127.0.0.1:3002/blocks/tip/height", () => HttpResponse.text(runCmd(`${BCLI} getblockcount`))),
  http.get("http://127.0.0.1:3002/blocks/tip/hash", () => HttpResponse.text(runCmd(`${BCLI} getbestblockhash`))),
  http.get("http://127.0.0.1:3002/block-height/:height", ({ params }) => HttpResponse.text(runCmd(`${BCLI} getblockhash ${params.height}`))),
  http.get("http://127.0.0.1:3002/block/:hash/header", ({ params }) => HttpResponse.text(runCmd(`${BCLI} getblockheader ${params.hash} false`))),
  http.get("http://127.0.0.1:3002/fee-estimates", () => HttpResponse.json({ "1": 15.0, "6": 8.0, "144": 2.0 })),
  http.post(lspApiUrl, async ({ request }) => {
    const { id, method, params } = (await request.clone().json()) as any;
    if (method === "lsps2.get_versions") return HttpResponse.json({ jsonrpc: "2.0", id, result: { versions: [1] } });
    if (method === "lsps2.get_info")
      return HttpResponse.json({
        jsonrpc: "2.0", id,
        result: {
          opening_fee_params_menu: [{
            opening_fee_params_id: "test_fee_params_id",
            min_fee_msat: "250000", proportional_fee_ppm: 1000,
            min_lifetime_blocks: 2016, cltv_expiry_delta: 144,
            valid_until: "2026-06-30T00:00:00Z",
          }],
          min_payment_size_msat: "1000", max_payment_size_msat: "100000000",
        },
      });
    if (method === "lsps2.buy")
      return HttpResponse.json({
        jsonrpc: "2.0", id,
        result: { jit_channel_scid: mockJitScid, lsp_node_id: lspPubkey, client_node_id: params.client_node_id, payment_size_msat: params.opening_fee_params.min_fee_msat, cltv_expiry_delta: 144 },
      });
    return HttpResponse.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  })
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
    config: { network: "regtest", esploraUrl: "http://127.0.0.1:3002" },
    storage: makeStorage(db),
    socketProvider: new TCPStreamProvider(),
    wasmBinary: loadWasmBinary(),
    logger: { info: () => {}, warn: () => {}, error: (m, ...a) => console.error(`[ERROR] ${m}`, ...a) },
  });
}

describe("Wallet recovery after storage wipe", () => {
  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: "bypass" });
    try { runCmd(`${BCLI} generatetoaddress 1 ${MINE_ADDR}`); } catch { /* ignore */ }
    for (let i = 0; i < 30; i++) {
      try {
        const info = JSON.parse(runCmd(`${LNCLI} getinfo`));
        if (info.identity_pubkey) lspPubkey = info.identity_pubkey;
        if (info.synced_to_chain) break;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }, 60000);
  afterEach(() => mswServer.resetHandlers());
  afterAll(() => mswServer.close());

  it("recovers channel + funds into a fresh wallet and can still keysend", async () => {
    const lsp = { name: "libre-lnd", pubkey: lspPubkey, connection_string: `${lspPubkey}@127.0.0.1:9735`, api_url: lspApiUrl, protocols: ["lsps2" as const] };

    // --- Wallet A: fund via JIT channel ---
    const dbA = new Map<string, string>();
    const walletA = newWallet(dbA);
    let channelReady = false, paymentClaimed = false;
    const listenerA = (e: Event) => {
      if (e.constructor.name === "Event_ChannelReady") channelReady = true;
      else if (e instanceof Event_PaymentClaimable) paymentClaimed = true;
    };
    walletA.addEventListener(listenerA);
    await walletA.start();
    const nodeId = bytesToHex(walletA.getChannelManager()!.get_our_node_id());
    await walletA.connectPeer(lsp.pubkey, "127.0.0.1", 9735);
    await new Promise((r) => setTimeout(r, 2000));

    const openPromise = runCmdAsync(`${LNCLI} openchannel --node_key ${nodeId} --local_amt 500000 --zero_conf --private --channel_type anchors`).catch(() => {});
    for (let i = 0; i < 30 && !channelReady; i++) await new Promise((r) => setTimeout(r, 500));
    expect(channelReady).toBe(true);

    let isActive = false;
    for (let i = 0; i < 15 && !isActive; i++) {
      try {
        const chan = JSON.parse(runCmd(`${LNCLI} listchannels`)).channels.find((c: any) => c.remote_pubkey === nodeId);
        if (chan) { mockJitScid = chan.peer_scid_alias || chan.alias_scids[0]; isActive = chan.active; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(isActive).toBe(true);
    await new Promise((r) => setTimeout(r, 15000));

    const invoice = await walletA.requestLSPS2Invoice({ amountSats: 20000, description: "JIT", lsp });
    const payPromise = runCmdAsync(`${LNCLI} payinvoice --force --pay_req ${invoice}`).catch(() => {});
    for (let i = 0; i < 30 && !paymentClaimed; i++) await new Promise((r) => setTimeout(r, 500));
    expect(paymentClaimed).toBe(true);
    runCmd(`${BCLI} generatetoaddress 1 ${MINE_ADDR}`);
    await new Promise((r) => setTimeout(r, 5000));
    await openPromise; await payPromise;

    const channelsA = walletA.getChannelManager()!.list_channels().length;
    expect(channelsA).toBe(1);
    // Opening + funding the channel changed state, so the version must have advanced.
    expect(walletA.getStateVersion()).toBeGreaterThan(0);

    // --- Export, then wipe (drop walletA + dbA) ---
    const seedHex = dbA.get("ldk_seed")!;
    const blob = await walletA.exportState();
    walletA.removeEventListener(listenerA);
    await walletA.stop();

    // --- Wallet B: fresh empty storage, import, start ---
    const dbB = new Map<string, string>();
    const walletB = newWallet(dbB);
    await walletB.importState(blob, seedHex);
    await walletB.start();
    expect(bytesToHex(walletB.getChannelManager()!.get_our_node_id())).toBe(nodeId);
    expect(walletB.getChannelManager()!.list_channels().length).toBe(1);
    // The restored wallet loaded the persisted state_version (non-zero).
    expect(walletB.getStateVersion()).toBeGreaterThan(0);

    // Reconnect to the peer so the recovered channel re-establishes.
    await walletB.connectPeer(lsp.pubkey, "127.0.0.1", 9735);
    // Wait for LND to see the channel as active again (up to 30 s), then add a small buffer.
    let chanReActive = false;
    for (let i = 0; i < 30 && !chanReActive; i++) {
      try {
        const chan = JSON.parse(runCmd(`${LNCLI} listchannels`)).channels.find((c: any) => c.remote_pubkey === nodeId);
        if (chan?.active) chanReActive = true;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    await new Promise((r) => setTimeout(r, 3000)); // extra buffer for LDK-side readiness

    // --- The recovered wallet sends a keysend boost; LND must receive it ---
    const FEED_GUID = "recovery-feed-guid";
    const BOOST_SATS = 5000;
    // Capture highest add_index before sending so we only match invoices created AFTER this point,
    // filtering out any settled 5000-sat keysends from prior test runs in this regtest environment.
    let preMaxAddIndex = 0;
    try {
      const existingInvoices = JSON.parse(runCmd(`${LNCLI} listinvoices`)).invoices || [];
      for (const inv of existingInvoices) {
        const idx = Number(inv.add_index);
        if (idx > preMaxAddIndex) preMaxAddIndex = idx;
      }
    } catch { /* ignore, default to 0 */ }

    const keysendRes = await walletB.sendKeysendPayment({
      destinationPubkey: lspPubkey,
      amountSats: BOOST_SATS,
      customRecords: {
        7629169: JSON.stringify({ action: "boost", value_msat_total: BOOST_SATS * 1000, app_name: "libre-recovery-test", guid: FEED_GUID }),
        7629175: FEED_GUID,
      },
    });
    expect(keysendRes.ok).toBe(true);

    let received: any = null;
    for (let i = 0; i < 60 && !received; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const invoices = JSON.parse(runCmd(`${LNCLI} listinvoices`)).invoices || [];
        received = invoices.find((inv: any) => inv.is_keysend && (inv.state === "SETTLED" || inv.settled === true) && Number(inv.amt_paid_sat) === BOOST_SATS && Number(inv.add_index) > preMaxAddIndex);
      } catch { /* retry */ }
    }
    expect(received).toBeTruthy();
    const cr: Record<string, string> = received.htlcs?.[0]?.custom_records || {};
    expect(Buffer.from(cr["7629175"], "hex").toString("utf8")).toBe(FEED_GUID);

    await walletB.stop();
  }, 180000);
});
