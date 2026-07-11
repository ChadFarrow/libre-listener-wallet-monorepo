// @vitest-environment node
//
// End-to-end proof that a peer's lnd node learns this wallet's alias — the "Unknown peer" fix.
//
// Why direct delivery: LDK's PeerManager.broadcast_node_announcement only forwards gossip to
// peers that REQUESTED a gossip sync (sent gossip_timestamp_filter). lnd never requests one
// from a no-gossip-features browser wallet (IgnoringMessageHandler routing), so the legacy
// broadcast reached zero peers — verified here with lnd PEER=trace wire logs showing every
// message from the wallet EXCEPT any NodeAnnouncement. The SDK now sends its signed BOLT7
// node_announcement (type 257) directly through the custom-message path on the peer tick.
//
// Why the channel matters: lnd discards node_announcements for nodes not in its graph; its own
// (private, zero-conf) channel to the wallet is what puts the wallet's node there. The SDK
// re-announces when a channel first becomes ready, which is the announcement lnd finally keeps.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
    exec(cmd, { encoding: "utf8" }, (err, stdout) => {
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
const ALIAS = "chads-test-wallet";

let lspPubkey = "";

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
  )
);

async function lndNodeAlias(pubkey: string): Promise<string | undefined> {
  try {
    const out = await runCmdAsync(`${LNCLI} getnodeinfo --pub_key ${pubkey}`);
    return JSON.parse(out).node?.alias;
  } catch {
    return undefined; // node not in lnd's graph (yet)
  }
}

describe("node alias reaches the peer's lnd (private channel)", () => {
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

  afterAll(() => mswServer.close());

  it("lnd getnodeinfo shows the configured alias once a private channel is ready", async () => {
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
        alias: ALIAS,
        trustedZeroConfPeers: [lspPubkey],
      } as any,
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
    console.log(`[TEST] LDK node id: ${ourNodeId}, alias: "${ALIAS}"`);

    await wallet.connectPeer(lspPubkey, "127.0.0.1", 9735);
    await new Promise((r) => setTimeout(r, 2000));
    expect(runCmd(`${LNCLI} listpeers`)).toContain(ourNodeId);

    // Open a private zero-conf channel from lnd — this is what puts the wallet's node into
    // lnd's local graph so the (re-)announcement is accepted.
    const openPromise = runCmdAsync(
      `${LNCLI} openchannel --node_key ${ourNodeId} --local_amt 500000 --zero_conf --private --channel_type anchors`
    ).catch((err) => console.error(`[TEST] openchannel failed: ${err.message}`));

    let channelReady = false;
    for (let i = 0; i < 40 && !channelReady; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (wallet.getChannels().some((c) => c.isChannelReady)) channelReady = true;
    }
    expect(channelReady).toBe(true);
    runCmd(`${BCLI} generatetoaddress 1 ${MINE_ADDR}`);
    await openPromise;

    // The peer tick runs every 10s; the ready-channel re-announce lands on the first tick
    // after channel_ready. Give it a few ticks.
    let alias: string | undefined;
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      alias = await lndNodeAlias(ourNodeId);
      if (alias === ALIAS) break;
    }
    console.log(`[TEST] lnd sees alias: ${JSON.stringify(alias)}`);
    expect(alias).toBe(ALIAS);

    await wallet.stop();
  }, 180000);
});
