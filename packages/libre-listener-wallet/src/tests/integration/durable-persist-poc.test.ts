// @vitest-environment node
// Layer C GATE: proves the WASM binding honours ChannelMonitorUpdateStatus::InProgress — i.e. with
// the durable persister wired (index.ts now always wraps the monitor persister via
// createDurablePersist), (a) a channel opens and a keysend settles (reconcile works), and
// (b) when the durable flush is BLOCKED (the injected storage provider's setItem/removeItem is held
// open), LDK does NOT advance — the outbound keysend never reaches the counterparty — until the
// flush is released. If (b) fails (the payment settles while writes are held), InProgress is being
// ignored by the binding -> Layer C provides no protection -> STOP (see task-3-brief.md Step 3).
//
// Harness preamble (runCmd/runCmdAsync/loadWasmBinary/TCPStreamProvider/mswServer/BCLI/LNCLI) is
// copied from tests/integration/recovery.test.ts, which this suite runs alongside against the same
// docker-compose regtest stack (bitcoind + electrs/esplora :3002 + lnd :9735). No real dev LSP
// server is needed: channels are opened directly via `lncli openchannel --zero_conf`, and the
// lsps2.* JSON-RPC calls are MSW-mocked purely to build a route-hinted invoice for the JIT-style
// receive test — same pattern recovery.test.ts uses.
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
import { Event, Event_ChannelReady, Event_PaymentClaimable, Event_PaymentClaimed } from "lightningdevkit";

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

// Plain in-memory storage (same shape as recovery.test.ts's makeStorage).
function makeStorage(db: Map<string, string>): SecureStorageProvider {
  return {
    getItem: async (k) => db.get(k) || null,
    setItem: async (k, v) => { db.set(k, v); },
    removeItem: async (k) => { db.delete(k); },
  };
}

// A storage wrapper whose setItem/removeItem can be switched between "release" (passthrough,
// resolves immediately) and "hold" (the returned promise never resolves until release() is called).
// Layered over a real in-memory Map so reads/writes still behave like a real KVStore backend —
// only the DURABLE-COMMIT TIMING is controlled, which is exactly what StorageCache.flush() awaits.
function makeHoldableStorage(db: Map<string, string>) {
  let held = false;
  const pendingResolvers: Array<() => void> = [];
  function commit(op: () => void): Promise<void> {
    if (!held) {
      op();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      pendingResolvers.push(() => {
        op();
        resolve();
      });
    });
  }
  const storage: SecureStorageProvider = {
    getItem: async (k) => db.get(k) ?? null,
    setItem: (k, v) => commit(() => { db.set(k, v); }),
    removeItem: (k) => commit(() => { db.delete(k); }),
  };
  return {
    storage,
    hold: () => { held = true; },
    // Flip back to passthrough AND resolve every write that was held.
    release: () => {
      held = false;
      while (pendingResolvers.length > 0) pendingResolvers.shift()!();
    },
  };
}

function newWallet(storage: SecureStorageProvider): LibreListenerWallet {
  return new LibreListenerWallet({
    // The regtest LND is the trusted LSP here, so allow its 0-conf JIT channel.
    config: { network: "regtest", esploraUrl: "http://127.0.0.1:3002", trustedZeroConfPeers: [lspPubkey] },
    storage,
    socketProvider: new TCPStreamProvider(),
    wasmBinary: loadWasmBinary(),
    logger: { info: () => {}, warn: () => {}, error: (m, ...a) => console.error(`[ERROR] ${m}`, ...a) },
  });
}

// Opens a real zero-conf anchors channel FROM libre-lnd TO the given wallet, waits for
// Event_ChannelReady on our side and for LND to report the channel active. Returns the wallet's
// node id (hex) once the channel is ready to carry payments in either direction.
async function fundZeroConfChannel(wallet: LibreListenerWallet): Promise<string> {
  let channelReady = false;
  const listener = (e: Event) => {
    if (e instanceof Event_ChannelReady) channelReady = true;
  };
  wallet.addEventListener(listener);
  await wallet.start();
  const nodeId = bytesToHex(wallet.getChannelManager()!.get_our_node_id());
  await wallet.connectPeer(lspPubkey, "127.0.0.1", 9735);
  await new Promise((r) => setTimeout(r, 2000));

  const openPromise = runCmdAsync(
    `${LNCLI} openchannel --node_key ${nodeId} --local_amt 500000 --zero_conf --private --channel_type anchors`
  ).catch(() => {});
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
  await new Promise((r) => setTimeout(r, 15000)); // buffer for LDK-side readiness
  await openPromise;

  wallet.removeEventListener(listener);
  return nodeId;
}

describe("Layer C durable-persist gate (integration)", () => {
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

  it("opens a channel and settles a keysend with the durable persister (reconcile works)", async () => {
    const db = new Map<string, string>();
    const wallet = newWallet(makeStorage(db));

    let paymentClaimed = false;
    const claimListener = (e: Event) => {
      if (e instanceof Event_PaymentClaimable) paymentClaimed = true;
    };
    wallet.addEventListener(claimListener);

    await fundZeroConfChannel(wallet);

    const lsp = { name: "libre-lnd", pubkey: lspPubkey, connection_string: `${lspPubkey}@127.0.0.1:9735`, api_url: lspApiUrl, protocols: ["lsps2" as const] };
    const invoice = await wallet.requestLSPS2Invoice({ amountSats: 20000, description: "Layer C reconcile", lsp });
    const payPromise = runCmdAsync(`${LNCLI} payinvoice --force --pay_req ${invoice}`).catch(() => {});
    for (let i = 0; i < 30 && !paymentClaimed; i++) await new Promise((r) => setTimeout(r, 500));
    expect(paymentClaimed).toBe(true);
    runCmd(`${BCLI} generatetoaddress 1 ${MINE_ADDR}`);
    await payPromise;

    wallet.removeEventListener(claimListener);
    await wallet.stop();
  }, 120_000);

  it("does NOT advance channel state while the durable flush is blocked (InProgress honoured)", async () => {
    // NOTE on direction: the channel is opened by LND with all value on LND's side (the wallet
    // contributes no funding and gets no push_amt), so the wallet has 0 outbound capacity and
    // cannot originate a payment. This test instead uses the receive direction (LND pays the
    // wallet, same as the reconcile test above) — receiving an HTLC still drives a channel-monitor
    // update on OUR side (the incoming commitment_signed must be persisted before LDK will emit
    // Event_PaymentClaimable or send our revoke_and_ack back to the peer), so it's an equally valid
    // (and, since it's observed directly via our own wallet's LDK events rather than inferred from
    // the counterparty's invoice DB, a more direct) way to prove the InProgress pause.
    const db = new Map<string, string>();
    const holdable = makeHoldableStorage(db);
    const wallet = newWallet(holdable.storage);

    let paymentClaimable = false;
    let paymentClaimedFinal = false;
    const listener = (e: Event) => {
      if (e instanceof Event_PaymentClaimable) paymentClaimable = true;
      else if (e instanceof Event_PaymentClaimed) paymentClaimedFinal = true;
    };
    wallet.addEventListener(listener);

    await fundZeroConfChannel(wallet);

    const lsp = { name: "libre-lnd", pubkey: lspPubkey, connection_string: `${lspPubkey}@127.0.0.1:9735`, api_url: lspApiUrl, protocols: ["lsps2" as const] };
    const PAY_SATS = 4321; // distinct from the reconcile test's amount to avoid crosstalk
    const invoice = await wallet.requestLSPS2Invoice({ amountSats: PAY_SATS, description: "Layer C pause-proof", lsp });

    // --- Engage the durability gate: every subsequent commit to this wallet's storage hangs, so
    // the durable ack (channel_monitor_updated) that would unblock LDK is withheld indefinitely
    // until release() is called. ---
    holdable.hold();

    const payPromise = runCmdAsync(`${LNCLI} payinvoice --force --pay_req ${invoice}`).catch(() => {});

    // --- Bounded wait WHILE BLOCKED: LDK must NOT advance far enough to tell us this payment is
    // claimable. If it does, InProgress is being ignored by the binding and Layer C provides no
    // protection. ---
    for (let i = 0; i < 20 && !paymentClaimable; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(
      paymentClaimable,
      "Layer C GATE FAILURE: Event_PaymentClaimable fired (LDK advanced channel state) WHILE the " +
      "durable flush was blocked (channel_monitor_updated was withheld). This means the WASM " +
      "binding does NOT honour ChannelMonitorUpdateStatus::InProgress. Layer C provides no " +
      "protection on this binding; revert the index.ts wiring and escalate."
    ).toBe(false);

    // --- Release the gate: the withheld ack can now land, and LDK should proceed. ---
    holdable.release();

    for (let i = 0; i < 60 && !paymentClaimedFinal; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(
      paymentClaimedFinal,
      "The payment never reached Event_PaymentClaimed even after the durable flush was released — " +
      "either the reconcile path is broken or the payment failed for an unrelated reason."
    ).toBe(true);

    // Cross-check from the payer's side too: LND's own payinvoice call should have completed.
    runCmd(`${BCLI} generatetoaddress 1 ${MINE_ADDR}`);
    await payPromise;

    wallet.removeEventListener(listener);
    await wallet.stop();
  }, 120_000);
});
