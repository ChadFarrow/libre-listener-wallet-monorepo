// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  LibreListenerWallet,
  SecureStorageProvider,
  WebSocketStreamProvider,
  WebSocketConnection,
} from "../../index";
import { bytesToHex, hexToBytes } from "../../storage-cache";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import * as fs from "fs";
import * as path from "path";
import * as net from "net";
import { execSync, exec } from "child_process";
import {
  EventHandler,
  Event,
  Event_PaymentClaimable,
  Result_NoneReplayEventZ,
  Option_ThirtyTwoBytesZ_Some,
} from "lightningdevkit";

// Helper to run docker commands
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
      if (err) {
        console.error(`Error running async command: ${cmd}`, stderr || err.message);
        reject(err);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

function getLndChannelAlias(remoteNodeId: string): string {
  const channelListStr = runCmd("docker exec libre-lnd lncli --network=regtest listchannels");
  const channelList = JSON.parse(channelListStr);
  const chan = channelList.channels.find(
    (c: any) => c.remote_pubkey === remoteNodeId
  );
  if (!chan) {
    throw new Error(`No channel found to remote node ${remoteNodeId}`);
  }
  return chan.peer_scid_alias || chan.alias_scids[0];
}

function loadWasmBinary(): Uint8Array {
  const paths = [
    path.resolve(__dirname, "../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(__dirname, "../../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(__dirname, "../../../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(__dirname, "../../../../../node_modules/.pnpm/node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "../../node_modules/lightningdevkit/liblightningjs.wasm"),
  ];

  for (const p of paths) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p);
    }
  }
  throw new Error("Could not find liblightningjs.wasm");
}

class TCPStreamProvider implements WebSocketStreamProvider {
  async connect(address: string, port: number): Promise<WebSocketConnection> {
    const socket = net.connect(port, address);

    const conn: WebSocketConnection = {
      send: (data: Uint8Array) => {
        socket.write(data);
      },
      close: () => {
        socket.destroy();
      },
    };

    socket.on("data", (data) => {
      conn.onmessage?.(new Uint8Array(data));
    });

    socket.on("error", (err) => {
      conn.onerror?.(err);
    });

    socket.on("close", () => {
      conn.onclose?.();
    });

    return new Promise((resolve, reject) => {
      socket.once("connect", () => {
        resolve(conn);
      });
      socket.once("error", (err) => {
        reject(err);
      });
    });
  }
}

const lspApiUrl = "http://127.0.0.1:9099/lsps2";
let mockJitScid = "1234567890123456";
let lspPubkey = "02bdafbf7a60765a9ab4673350c1b5954449e290f498d1ff3a77c58eb7cebfbf24";

const mswServer = setupServer(
  // Esplora endpoints (pointing to local electrs inside integration test)
  http.get("http://127.0.0.1:3002/blocks/tip/height", async () => {
    const height = runCmd("docker exec libre-bitcoind bitcoin-cli -regtest -rpcuser=libre -rpcpassword=listener getblockcount");
    return HttpResponse.text(height);
  }),
  http.get("http://127.0.0.1:3002/blocks/tip/hash", async () => {
    const hash = runCmd("docker exec libre-bitcoind bitcoin-cli -regtest -rpcuser=libre -rpcpassword=listener getbestblockhash");
    return HttpResponse.text(hash);
  }),
  http.get("http://127.0.0.1:3002/block-height/:height", async ({ params }) => {
    const hash = runCmd(`docker exec libre-bitcoind bitcoin-cli -regtest -rpcuser=libre -rpcpassword=listener getblockhash ${params.height}`);
    return HttpResponse.text(hash);
  }),
  http.get("http://127.0.0.1:3002/block/:hash/header", async ({ params }) => {
    const header = runCmd(`docker exec libre-bitcoind bitcoin-cli -regtest -rpcuser=libre -rpcpassword=listener getblockheader ${params.hash} false`);
    return HttpResponse.text(header);
  }),
  http.get("http://127.0.0.1:3002/fee-estimates", () => {
    return HttpResponse.json({ "1": 15.0, "6": 8.0, "144": 2.0 });
  }),

  // LSPS2 JIT API Mocks
  http.post(lspApiUrl, async ({ request }) => {
    const body = (await request.clone().json()) as any;
    const { id, method, params } = body;

    if (method === "lsps2.get_versions") {
      return HttpResponse.json({
        jsonrpc: "2.0",
        id,
        result: { versions: [1] },
      });
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

describe("LibreListenerWallet LSPS2 Integration Test Suite", () => {
  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: "bypass" });
    console.log("[TEST] Mining 1 block to trigger LND sync...");
    try {
      runCmd(`docker exec libre-bitcoind bitcoin-cli -regtest -rpcuser=libre -rpcpassword=listener generatetoaddress 1 bcrt1qwqp2ru0sx58gpv4fmleuf02wcmu8rs5w93ld6u`);
    } catch (mineErr: any) {
      console.warn("[TEST] Could not mine block during beforeAll:", mineErr.message);
    }
    
    console.log("[TEST] Waiting for LND to be synced to chain...");
    let synced = false;
    for (let i = 0; i < 30; i++) {
      try {
        const infoStr = runCmd("docker exec libre-lnd lncli --network=regtest getinfo");
        const info = JSON.parse(infoStr);
        if (info.identity_pubkey) {
          lspPubkey = info.identity_pubkey;
        }
        synced = info.synced_to_chain;
        console.log(`[TEST] LND synced_to_chain: ${synced}, block height: ${info.block_height}`);
        if (synced) break;
      } catch (err: any) {
        console.warn("[TEST] Error querying LND getinfo:", err.message);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log(`[TEST] LND is synced. LSP Node ID: ${lspPubkey}`);
  }, 60000);

  afterEach(() => {
    mswServer.resetHandlers();
  });

  afterAll(() => {
    mswServer.close();
  });

  it("should connect to LSP, request LSPS2 invoice, accept zero-conf channel, and claim payment", async () => {
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
      config: {
        network: "regtest",
        esploraUrl: "http://127.0.0.1:3002",
        // The regtest LND is the trusted LSP here, so allow its 0-conf JIT channel.
        trustedZeroConfPeers: [lspPubkey],
      },
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
    console.log(`[TEST] LDK client node ID: ${ourNodeId}`);

    // Connect peer
    await wallet.connectPeer(lsp.pubkey, "127.0.0.1", 9735);
    console.log("[TEST] Connected to LND peer, sleeping 2s for handshake...");
    console.log("[TEST] Before setTimeout 2s");
    await new Promise((r) => setTimeout(r, 2000));
    console.log("[TEST] After setTimeout 2s");

    // Verify peer list on LND
    console.log("[TEST] Before runCmd listpeers");
    const peersStr = runCmd("docker exec libre-lnd lncli --network=regtest listpeers");
    console.log("[TEST] After runCmd listpeers");
    console.log(`[TEST] LND Peers: ${peersStr}`);
    expect(peersStr).toContain(ourNodeId);

    // Setup LDK event listeners to monitor success
    let paymentClaimed = false;
    let channelReady = false;

    const testListener = (event: Event) => {
      const name = event.constructor.name;
      console.log(`[TEST LDK EVENT LISTENER] Received event: ${name}`);
      if (name === "Event_ChannelReady") {
        console.log("[TEST LDK EVENT LISTENER] ChannelReady detected!");
        channelReady = true;
      } else if (event instanceof Event_PaymentClaimable) {
        console.log("[TEST LDK EVENT LISTENER] PaymentClaimable detected!");
        paymentClaimed = true;
      }
    };

    wallet.addEventListener(testListener);

    // 1. Manually trigger LND to open a zero-conf channel to LDK (async)
    console.log("[TEST] Instructing LND to open zero-conf channel to LDK (async)...");
    const openPromise = runCmdAsync(
      `docker exec libre-lnd lncli --network=regtest openchannel --node_key ${ourNodeId} --local_amt 500000 --zero_conf --private --channel_type anchors`
    ).then((res) => {
      console.log(`[TEST] openchannel completed: ${res}`);
    }).catch((err) => {
      console.error(`[TEST] openchannel failed: ${err.message}`);
    });

    // 2. Wait for the channel to become ready (up to 15s)
    console.log("[TEST] Waiting for ChannelReady...");
    for (let i = 0; i < 30; i++) {
      if (channelReady) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(channelReady).toBe(true);

    // 3. Wait for LND to mark the channel as active
    console.log("[TEST] Polling LND listchannels to wait for active channel...");
    let actualAlias = "";
    let isActive = false;
    for (let i = 0; i < 15; i++) {
      try {
        const channelListStr = runCmd("docker exec libre-lnd lncli --network=regtest listchannels");
        const channelList = JSON.parse(channelListStr);
        const chan = channelList.channels.find(
          (c: any) => c.remote_pubkey === ourNodeId
        );
        if (chan) {
          actualAlias = chan.peer_scid_alias || chan.alias_scids[0];
          isActive = chan.active;
          console.log(`[TEST] LND channel object: ${JSON.stringify(chan, null, 2)}`);
          if (isActive) break;
        } else {
          console.log("[TEST] LND channel not found in listchannels yet");
        }
      } catch (err: any) {
        console.warn("[TEST] Error polling listchannels:", err.message);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(isActive).toBe(true);
    mockJitScid = actualAlias;
    console.log("[TEST] Sleeping 15s to let LND's router register the link...");
    await new Promise((r) => setTimeout(r, 15000));

    // 4. Request LSPS2 Invoice
    const invoice = await wallet.requestLSPS2Invoice({
      amountSats: 20000,
      description: "Integration test JIT",
      lsp,
    });
    expect(invoice).toBeDefined();
    console.log(`[TEST] Generated JIT invoice: ${invoice}`);

    try {
      const decoded = runCmd(`docker exec libre-lnd lncli --network=regtest decodepayreq ${invoice}`);
      console.log(`[TEST] Decoded JIT invoice: ${decoded}`);
    } catch (decodeErr: any) {
      console.error(`Failed to decode invoice: ${decodeErr.message}`);
    }

    // 5. Instruct LND to pay the LSPS2 JIT invoice (async to avoid blocking Node.js event loop)
    console.log("[TEST] Instructing LND to pay the JIT invoice (async)...");
    const payPromise = runCmdAsync(
      `docker exec libre-lnd lncli --network=regtest payinvoice --force --pay_req ${invoice}`
    ).then((res) => {
      console.log(`[TEST] payinvoice completed: ${res}`);
    }).catch((err) => {
      console.error(`[TEST] payinvoice failed: ${err.message}`);
      try {
        const logs = runCmd("docker logs libre-lnd --tail 100");
        console.log(`[TEST] LND logs after failure:\n${logs}`);
      } catch (logErr: any) {
        console.error(`Failed to fetch LND logs: ${logErr.message}`);
      }
    });

    // 6. Wait for PaymentClaimable to be detected (up to 15s)
    console.log("[TEST] Waiting for PaymentClaimable...");
    for (let i = 0; i < 30; i++) {
      if (paymentClaimed) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(paymentClaimed).toBe(true);

    // Mine blocks to confirm channel and resolve HTLCs
    console.log("[TEST] Mining 1 block on regtest...");
    runCmd(`docker exec libre-bitcoind bitcoin-cli -regtest -rpcuser=libre -rpcpassword=listener generatetoaddress 1 bcrt1qwqp2ru0sx58gpv4fmleuf02wcmu8rs5w93ld6u`);

    // Give time to settle
    console.log("[TEST] Waiting 5s to settle...");
    await new Promise((r) => setTimeout(r, 5000));

    await openPromise;
    await payPromise;

    wallet.removeEventListener(testListener);
    await wallet.stop();

    // Verify channel is opened and payment claimed
    expect(channelReady).toBe(true);
    expect(paymentClaimed).toBe(true);
  }, 60000);
});
