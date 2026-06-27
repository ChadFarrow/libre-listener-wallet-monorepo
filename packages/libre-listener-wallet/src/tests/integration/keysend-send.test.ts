// @vitest-environment node
//
// End-to-end proof of the OUTBOUND keysend boost path (the product's differentiator):
// a listener wallet, once it has a funded channel, sends a keysend payment carrying
// bLIP-10 boostagram TLVs to a "podcaster" node (the regtest LND), and we assert the
// recipient actually receives it WITH the custom TLV records intact.
//
// Reuses the proven LSPS2 JIT setup to give the client spendable (local) balance first.
// Requires the docker-compose regtest stack with LND running `--accept-keysend`.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
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
  try {
    return execSync(cmd, { encoding: "utf8" }).trim();
  } catch (err: any) {
    console.error(`Error running command: ${cmd}`, err.stderr || err.message);
    throw err;
  }
}

function runCmdAsync(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

function loadWasmBinary(): Uint8Array {
  const paths = [
    path.resolve(__dirname, "../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(__dirname, "../../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(__dirname, "../../../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "../../node_modules/lightningdevkit/liblightningjs.wasm"),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return fs.readFileSync(p);
  }
  throw new Error("Could not find liblightningjs.wasm");
}

class TCPStreamProvider implements WebSocketStreamProvider {
  async connect(address: string, port: number): Promise<WebSocketConnection> {
    const socket = net.connect(port, address);
    const conn: WebSocketConnection = {
      send: (data: Uint8Array) => socket.write(data),
      close: () => socket.destroy(),
    };
    socket.on("data", (data) => conn.onmessage?.(new Uint8Array(data)));
    socket.on("error", (err) => conn.onerror?.(err));
    socket.on("close", () => conn.onclose?.());
    return new Promise((resolve, reject) => {
      socket.once("connect", () => resolve(conn));
      socket.once("error", (err) => reject(err));
    });
  }
}

const BCLI =
  "docker exec libre-bitcoind bitcoin-cli -regtest -rpcuser=libre -rpcpassword=listener";
const LNCLI = "docker exec libre-lnd lncli --network=regtest";
const MINE_ADDR = "bcrt1qwqp2ru0sx58gpv4fmleuf02wcmu8rs5w93ld6u";

const lspApiUrl = "http://127.0.0.1:9099/lsps2";
let mockJitScid = "1234567890123456";
let lspPubkey = "02bdafbf7a60765a9ab4673350c1b5954449e290f498d1ff3a77c58eb7cebfbf24";

const mswServer = setupServer(
  http.get("http://127.0.0.1:3002/blocks/tip/height", () =>
    HttpResponse.text(runCmd(`${BCLI} getblockcount`))
  ),
  http.get("http://127.0.0.1:3002/blocks/tip/hash", () =>
    HttpResponse.text(runCmd(`${BCLI} getbestblockhash`))
  ),
  http.get("http://127.0.0.1:3002/block-height/:height", ({ params }) =>
    HttpResponse.text(runCmd(`${BCLI} getblockhash ${params.height}`))
  ),
  http.get("http://127.0.0.1:3002/block/:hash/header", ({ params }) =>
    HttpResponse.text(runCmd(`${BCLI} getblockheader ${params.hash} false`))
  ),
  http.get("http://127.0.0.1:3002/fee-estimates", () =>
    HttpResponse.json({ "1": 15.0, "6": 8.0, "144": 2.0 })
  ),
  http.post(lspApiUrl, async ({ request }) => {
    const body = (await request.clone().json()) as any;
    const { id, method, params } = body;
    if (method === "lsps2.get_versions") {
      return HttpResponse.json({ jsonrpc: "2.0", id, result: { versions: [1] } });
    }
    if (method === "lsps2.get_info") {
      return HttpResponse.json({
        jsonrpc: "2.0",
        id,
        result: {
          opening_fee_params_menu: [
            {
              opening_fee_params_id: "test_fee_params_id",
              min_fee_msat: "250000",
              proportional_fee_ppm: 1000,
              min_lifetime_blocks: 2016,
              cltv_expiry_delta: 144,
              valid_until: "2026-06-30T00:00:00Z",
            },
          ],
          min_payment_size_msat: "1000",
          max_payment_size_msat: "100000000",
        },
      });
    }
    if (method === "lsps2.buy") {
      return HttpResponse.json({
        jsonrpc: "2.0",
        id,
        result: {
          jit_channel_scid: mockJitScid,
          lsp_node_id: lspPubkey,
          client_node_id: params.client_node_id,
          payment_size_msat: params.opening_fee_params.min_fee_msat,
          cltv_expiry_delta: 144,
        },
      });
    }
    return HttpResponse.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found" },
    });
  })
);

describe("LibreListenerWallet Keysend Boost (outbound) Integration", () => {
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
    console.log(`[TEST] Podcaster (LND) node id: ${lspPubkey}`);
  }, 60000);

  afterEach(() => mswServer.resetHandlers());
  afterAll(() => mswServer.close());

  it("sends a boostagram keysend over a JIT channel and the podcaster receives the bLIP-10 TLVs", async () => {
    const lsp = {
      name: "libre-lnd",
      pubkey: lspPubkey,
      connection_string: `${lspPubkey}@127.0.0.1:9735`,
      api_url: lspApiUrl,
      protocols: ["lsps2" as const],
    };

    const db = new Map<string, string>();
    const storage: SecureStorageProvider = {
      getItem: async (k) => db.get(k) || null,
      setItem: async (k, v) => {
        db.set(k, v);
      },
      removeItem: async (k) => {
        db.delete(k);
      },
    };

    const wallet = new LibreListenerWallet({
      config: { network: "regtest", esploraUrl: "http://127.0.0.1:3002" },
      storage,
      socketProvider: new TCPStreamProvider(),
      wasmBinary: loadWasmBinary(),
      logger: {
        info: (msg, ...args) => console.log(`[INFO] ${msg}`, ...args),
        warn: (msg, ...args) => console.warn(`[WARN] ${msg}`, ...args),
        error: (msg, ...args) => console.error(`[ERROR] ${msg}`, ...args),
      },
    });

    await wallet.start();
    const ourNodeId = bytesToHex(wallet.getChannelManager()!.get_our_node_id());
    console.log(`[TEST] Listener (LDK) node id: ${ourNodeId}`);

    await wallet.connectPeer(lsp.pubkey, "127.0.0.1", 9735);
    await new Promise((r) => setTimeout(r, 2000));
    expect(runCmd(`${LNCLI} listpeers`)).toContain(ourNodeId);

    let paymentClaimed = false;
    let channelReady = false;
    const listener = (event: Event) => {
      const name = event.constructor.name;
      if (name === "Event_ChannelReady") channelReady = true;
      else if (event instanceof Event_PaymentClaimable) paymentClaimed = true;
    };
    wallet.addEventListener(listener);

    // --- Phase 1: get the listener a funded channel via LSPS2 JIT (proven path) ---
    const openPromise = runCmdAsync(
      `${LNCLI} openchannel --node_key ${ourNodeId} --local_amt 500000 --zero_conf --private --channel_type anchors`
    ).catch((err) => console.error(`[TEST] openchannel failed: ${err.message}`));

    for (let i = 0; i < 30 && !channelReady; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(channelReady).toBe(true);

    let actualAlias = "";
    let isActive = false;
    for (let i = 0; i < 15 && !isActive; i++) {
      try {
        const chan = JSON.parse(runCmd(`${LNCLI} listchannels`)).channels.find(
          (c: any) => c.remote_pubkey === ourNodeId
        );
        if (chan) {
          actualAlias = chan.peer_scid_alias || chan.alias_scids[0];
          isActive = chan.active;
        }
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(isActive).toBe(true);
    mockJitScid = actualAlias;
    await new Promise((r) => setTimeout(r, 15000)); // let LND router register the link

    const invoice = await wallet.requestLSPS2Invoice({
      amountSats: 20000,
      description: "JIT funding for keysend test",
      lsp,
    });
    expect(invoice).toBeDefined();

    const payPromise = runCmdAsync(
      `${LNCLI} payinvoice --force --pay_req ${invoice}`
    ).catch((err) => console.error(`[TEST] payinvoice failed: ${err.message}`));

    for (let i = 0; i < 30 && !paymentClaimed; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(paymentClaimed).toBe(true);
    runCmd(`${BCLI} generatetoaddress 1 ${MINE_ADDR}`);
    await new Promise((r) => setTimeout(r, 5000));
    await openPromise;
    await payPromise;

    // The listener now has ~20000 sat of local (spendable) balance.

    // --- Phase 2: send a boostagram keysend back to the podcaster (LND) ---
    const FEED_GUID = "feed-guid-abc-123";
    const BOOST_SATS = 5000;
    const boostRecord = {
      action: "boost",
      value_msat_total: BOOST_SATS * 1000,
      app_name: "libre-listener-test",
      podcast: "The Test Cast",
      episode: "Episode 42",
      guid: FEED_GUID,
      episode_guid: "item-guid-xyz",
      ts: 137,
      message: "boosting from the integration test",
    };

    console.log(`[TEST] Sending ${BOOST_SATS} sat keysend boost to podcaster...`);
    const keysendRes = await wallet.sendKeysendPayment({
      destinationPubkey: lspPubkey,
      amountSats: BOOST_SATS,
      customRecords: {
        7629169: JSON.stringify(boostRecord), // bLIP-10 boostagram JSON
        7629175: FEED_GUID, // Podcast Index feedGuid
      },
    });
    console.log(`[TEST] sendKeysendPayment ->`, keysendRes);
    expect(keysendRes.ok).toBe(true);

    // --- Phase 3: assert the podcaster received it WITH the boostagram TLVs ---
    let received: any = null;
    for (let i = 0; i < 40 && !received; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const invoices = JSON.parse(runCmd(`${LNCLI} listinvoices`)).invoices || [];
        received = invoices.find(
          (inv: any) =>
            inv.is_keysend &&
            (inv.state === "SETTLED" || inv.settled === true) &&
            Number(inv.amt_paid_sat) === BOOST_SATS
        );
      } catch {
        /* retry */
      }
    }
    expect(received).toBeTruthy();
    console.log(`[TEST] Podcaster received keysend: amt_paid_sat=${received.amt_paid_sat}`);

    // custom_records are keyed by TLV type (string) with hex-encoded byte values (lncli output)
    const customRecords: Record<string, string> =
      received.htlcs?.[0]?.custom_records || {};
    expect(customRecords["7629175"]).toBeDefined();
    expect(customRecords["7629169"]).toBeDefined();

    const feedGuidReceived = Buffer.from(customRecords["7629175"], "hex").toString("utf8");
    expect(feedGuidReceived).toBe(FEED_GUID);

    const boostJson = Buffer.from(customRecords["7629169"], "hex").toString("utf8");
    const decodedBoost = JSON.parse(boostJson);
    expect(decodedBoost.app_name).toBe("libre-listener-test");
    expect(decodedBoost.action).toBe("boost");
    expect(decodedBoost.guid).toBe(FEED_GUID);

    wallet.removeEventListener(listener);
    await wallet.stop();
  }, 120000);
});
