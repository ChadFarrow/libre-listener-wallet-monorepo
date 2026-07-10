// @vitest-environment node
//
// End-to-end proof of the Lightning Address pay path: the wallet resolves a LUD-16 address
// against a real (local) LNURL-pay server, gets a REAL invoice minted by the regtest lnd,
// verifies its amount, and PAYS it over a live channel — asserting lnd actually settles it.
//
// The LNURL server here is a plain node:http server backed by `lncli addinvoice`, i.e. exactly
// what a podcaster's lnaddress provider does. Requires the docker-compose regtest stack.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  LibreListenerWallet,
  SecureStorageProvider,
  WebSocketStreamProvider,
  WebSocketConnection,
  resolveLnAddressInvoice,
} from "../../index";
import { bytesToHex } from "../../storage-cache";
import { setupServer } from "msw/node";
import { http as mswHttp, HttpResponse } from "msw";
import * as fs from "fs";
import * as path from "path";
import * as net from "net";
import * as http from "http";
import { execSync, exec } from "child_process";
import {
  Event,
  Event_ChannelReady,
  Event_PaymentSent,
  Bolt11Invoice,
  UtilMethods,
  Retry,
  Result_C3Tuple_ThirtyTwoBytesRecipientOnionFieldsRouteParametersZNoneZ_OK,
} from "lightningdevkit";

function runCmd(cmd: string): string {
  return execSync(cmd, { encoding: "utf8" }).trim();
}
function runCmdAsync(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
  });
}

function loadWasmBinary(): Uint8Array {
  const paths = [
    path.resolve(__dirname, "../../../node_modules/lightningdevkit/liblightningjs.wasm"),
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

const BCLI = "docker exec libre-bitcoind bitcoin-cli -regtest -rpcuser=libre -rpcpassword=listener";
const LNCLI = "docker exec libre-lnd lncli --network=regtest";
const MINE_ADDR = "bcrt1qwqp2ru0sx58gpv4fmleuf02wcmu8rs5w93ld6u";

// Esplora passthrough to the regtest bitcoind (same pattern as keysend-send.test.ts).
const mswServer = setupServer(
  mswHttp.get("http://127.0.0.1:3002/blocks/tip/height", () => HttpResponse.text(runCmd(`${BCLI} getblockcount`))),
  mswHttp.get("http://127.0.0.1:3002/blocks/tip/hash", () => HttpResponse.text(runCmd(`${BCLI} getbestblockhash`))),
  mswHttp.get("http://127.0.0.1:3002/block-height/:height", ({ params }) =>
    HttpResponse.text(runCmd(`${BCLI} getblockhash ${params.height}`))
  ),
  mswHttp.get("http://127.0.0.1:3002/block/:hash/header", ({ params }) =>
    HttpResponse.text(runCmd(`${BCLI} getblockheader ${params.hash} false`))
  ),
  mswHttp.get("http://127.0.0.1:3002/fee-estimates", () => HttpResponse.json({ "1": 2.0, "6": 2.0, "144": 2.0 }))
);

let lndPubkey = "";
let lnurlServer: http.Server;
let lnurlPort = 0;
// r_hash of the last invoice the LNURL server minted, so the test can assert lnd SETTLED it.
let lastRHash = "";

// A minimal real LNURL-pay provider: /.well-known/lnurlp/artist → payRequest; callback mints a
// REAL lnd invoice for exactly the requested msat.
function startLnurlServer(): Promise<number> {
  lnurlServer = http.createServer((req, res) => {
    const u = new URL(req.url || "/", `http://127.0.0.1:${lnurlPort}`);
    if (u.pathname === "/.well-known/lnurlp/artist") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          tag: "payRequest",
          callback: `http://127.0.0.1:${lnurlPort}/lnurlp/artist/cb`,
          minSendable: 1000,
          maxSendable: 100_000_000,
          metadata: '[["text/plain","pay the artist"]]',
          commentAllowed: 64,
        })
      );
      return;
    }
    if (u.pathname === "/lnurlp/artist/cb") {
      const amount = u.searchParams.get("amount");
      runCmdAsync(`${LNCLI} addinvoice --amt_msat ${amount} --memo lnurl-e2e`)
        .then((out) => {
          const inv = JSON.parse(out);
          lastRHash = inv.r_hash;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ pr: inv.payment_request }));
        })
        .catch((err) => {
          res.statusCode = 500;
          res.end(JSON.stringify({ status: "ERROR", reason: String(err?.message || err) }));
        });
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ status: "ERROR", reason: "not found" }));
  });
  return new Promise((resolve) => {
    lnurlServer.listen(0, "127.0.0.1", () => {
      lnurlPort = (lnurlServer.address() as net.AddressInfo).port;
      resolve(lnurlPort);
    });
  });
}

describe("Lightning Address (LNURL-pay) end-to-end", () => {
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
        if (info.identity_pubkey) lndPubkey = info.identity_pubkey;
        if (info.synced_to_chain) break;
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    await startLnurlServer();
  }, 60000);

  afterAll(() => {
    mswServer.close();
    lnurlServer?.close();
  });

  it(
    "resolves artist@host and PAYS the minted invoice over a live channel (lnd settles)",
    async () => {
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
        config: { network: "regtest", esploraUrl: "http://127.0.0.1:3002", trustedZeroConfPeers: [lndPubkey] },
        storage,
        socketProvider: new TCPStreamProvider(),
        wasmBinary: loadWasmBinary(),
      });
      await wallet.start();
      const ourNodeId = bytesToHex(wallet.getChannelManager()!.get_our_node_id());

      let channelReady = false;
      let paymentSent = false;
      wallet.addEventListener((event: Event) => {
        if (event instanceof Event_ChannelReady) channelReady = true;
        else if (event instanceof Event_PaymentSent) paymentSent = true;
      });

      await wallet.connectPeer(lndPubkey, "127.0.0.1", 9735);
      await new Promise((r) => setTimeout(r, 2000));

      // Zero-conf channel with sats PUSHED to the wallet, so it has spendable balance to pay with.
      const openPromise = runCmdAsync(
        `${LNCLI} openchannel --node_key ${ourNodeId} --local_amt 1000000 --push_amt 300000 --zero_conf --private --channel_type anchors`
      );
      for (let i = 0; i < 40 && !channelReady; i++) await new Promise((r) => setTimeout(r, 500));
      expect(channelReady).toBe(true);
      runCmd(`${BCLI} generatetoaddress 1 ${MINE_ADDR}`);
      await openPromise;
      // Let lnd's router register the link before paying through it.
      await new Promise((r) => setTimeout(r, 10000));

      // --- Resolve the lightning address (real HTTP → real invoice from lnd) ---
      const AMOUNT_MSAT = 25_000_000; // 25k sats
      const resolved = await resolveLnAddressInvoice({
        address: `artist@127.0.0.1:${lnurlPort}`,
        amountMsat: AMOUNT_MSAT,
        comment: "lnaddress e2e boost",
      });
      expect(resolved.invoice.startsWith("lnbcrt")).toBe(true);
      expect(lastRHash).not.toBe("");

      // --- Pay it exactly the way NWC pay_invoice does ---
      const invRes = Bolt11Invoice.constructor_from_str(resolved.invoice);
      expect(invRes.is_ok()).toBeTruthy();
      const paramRes = UtilMethods.constructor_payment_parameters_from_invoice((invRes as any).res);
      expect(paramRes.is_ok()).toBeTruthy();
      const tuple = (paramRes as Result_C3Tuple_ThirtyTwoBytesRecipientOnionFieldsRouteParametersZNoneZ_OK).res;
      const sendRes = wallet
        .getChannelManager()!
        .send_payment(tuple.get_a(), tuple.get_b(), crypto.getRandomValues(new Uint8Array(32)), tuple.get_c(), Retry.constructor_attempts(5));
      expect(sendRes.is_ok()).toBeTruthy();

      // --- Assert the recipient actually got paid (authoritative: lnd's invoice state) ---
      let settled = false;
      for (let i = 0; i < 60 && !settled; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          const inv = JSON.parse(await runCmdAsync(`${LNCLI} lookupinvoice ${lastRHash}`));
          settled = inv.state === "SETTLED" || inv.settled === true;
        } catch {
          /* retry */
        }
      }
      expect(settled).toBe(true);
      expect(paymentSent).toBe(true);

      await wallet.stop();
    },
    180000
  );
});
