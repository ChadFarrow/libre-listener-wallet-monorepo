// Shared harness for the regtest soak tests (restart, VSS-recovery, NWC). Reuses the exact setup
// proven by recovery.test.ts: real LDK WASM, a raw-TCP transport to the docker lnd, and an MSW
// bridge that answers the SDK's esplora calls straight from bitcoind. Not a test file itself.
import {
  LibreListenerWallet,
  SecureStorageProvider,
  WebSocketStreamProvider,
  WebSocketConnection,
} from "../../index";
import type { WalletConfig } from "@libre/shared";
import { setupServer, SetupServerApi } from "msw/node";
import { http, HttpResponse } from "msw";
import * as fs from "fs";
import * as path from "path";
import * as net from "net";
import { execSync, exec } from "child_process";
import { Event } from "lightningdevkit";

export const BCLI = "docker exec libre-bitcoind bitcoin-cli -regtest -rpcuser=libre -rpcpassword=listener";
export const LNCLI = "docker exec libre-lnd lncli --network=regtest";
export const MINE_ADDR = "bcrt1qwqp2ru0sx58gpv4fmleuf02wcmu8rs5w93ld6u";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function runCmd(cmd: string): string {
  return execSync(cmd, { encoding: "utf8" }).trim();
}
export function runCmdAsync(cmd: string): Promise<string> {
  return new Promise((resolve, reject) =>
    exec(cmd, { encoding: "utf8" }, (err, out) => (err ? reject(err) : resolve(out.trim()))),
  );
}

export function loadWasmBinary(): Uint8Array {
  const paths = [
    path.resolve(__dirname, "../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(__dirname, "../../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "../../node_modules/lightningdevkit/liblightningjs.wasm"),
  ];
  for (const p of paths) if (fs.existsSync(p)) return fs.readFileSync(p);
  throw new Error("Could not find liblightningjs.wasm");
}

export class TCPStreamProvider implements WebSocketStreamProvider {
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

export function createEsploraMsw(): SetupServerApi {
  return setupServer(
    http.get("http://127.0.0.1:3002/blocks/tip/height", () => HttpResponse.text(runCmd(`${BCLI} getblockcount`))),
    http.get("http://127.0.0.1:3002/blocks/tip/hash", () => HttpResponse.text(runCmd(`${BCLI} getbestblockhash`))),
    http.get("http://127.0.0.1:3002/block-height/:height", ({ params }) => HttpResponse.text(runCmd(`${BCLI} getblockhash ${params.height}`))),
    http.get("http://127.0.0.1:3002/block/:hash/header", ({ params }) => HttpResponse.text(runCmd(`${BCLI} getblockheader ${params.hash} false`))),
    http.get("http://127.0.0.1:3002/fee-estimates", () => HttpResponse.json({ "1": 15.0, "6": 8.0, "144": 2.0 })),
  );
}

// Wait for the docker lnd to be synced and return its node pubkey.
export async function waitForLndSynced(fallbackPubkey = ""): Promise<string> {
  let pubkey = fallbackPubkey;
  try { runCmd(`${BCLI} generatetoaddress 1 ${MINE_ADDR}`); } catch { /* ignore */ }
  for (let i = 0; i < 30; i++) {
    try {
      const info = JSON.parse(runCmd(`${LNCLI} getinfo`));
      if (info.identity_pubkey) pubkey = info.identity_pubkey;
      if (info.synced_to_chain) break;
    } catch { /* retry */ }
    await sleep(1000);
  }
  return pubkey;
}

export function makeStorage(db: Map<string, string>): SecureStorageProvider {
  return {
    getItem: async (k) => db.get(k) || null,
    setItem: async (k, v) => { db.set(k, v); },
    removeItem: async (k) => { db.delete(k); },
  };
}

export interface NewWalletOpts {
  lspPubkey: string;
  vssUrl?: string;
  configOverrides?: Partial<WalletConfig>;
  quiet?: boolean;
}

export function newWallet(db: Map<string, string>, opts: NewWalletOpts): LibreListenerWallet {
  return new LibreListenerWallet({
    config: {
      network: "regtest",
      esploraUrl: "http://127.0.0.1:3002",
      trustedZeroConfPeers: [opts.lspPubkey],
      ...(opts.vssUrl ? { vssUrl: opts.vssUrl } : {}),
      ...opts.configOverrides,
    },
    storage: makeStorage(db),
    socketProvider: new TCPStreamProvider(),
    wasmBinary: loadWasmBinary(),
    logger: opts.quiet === false
      ? { info: (m) => console.log(m), warn: (m) => console.warn(m), error: (m) => console.error(m) }
      : { info: () => {}, warn: () => {}, error: () => {} },
  });
}

// A channel force-close fires Event_ChannelClosed. In the node env class names are NOT minified,
// so constructor.name is a reliable discriminator here (unlike the minified PWA — see the
// event-dispatch gotcha).
export function attachCloseWatcher(wallet: LibreListenerWallet, onClose: (reason: string) => void): (e: Event) => void {
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

export async function lndSeesActiveChannel(nodeId: string): Promise<boolean> {
  try {
    const chan = JSON.parse(runCmd(`${LNCLI} listchannels`)).channels.find((c: any) => c.remote_pubkey === nodeId);
    return !!chan?.active;
  } catch {
    return false;
  }
}
export async function lndSeesForceClose(nodeId: string): Promise<boolean> {
  try {
    const pending = JSON.parse(runCmd(`${LNCLI} pendingchannels`));
    const waiting = [...(pending.waiting_close_channels || []), ...(pending.pending_force_closing_channels || [])];
    return waiting.some((c: any) => c.channel?.remote_node_pub === nodeId);
  } catch {
    return false;
  }
}

// Open a zero-conf channel FROM the docker lnd TO the (already-started, peer-connected) wallet, and
// wait until both sides see it. Returns once the wallet has one usable channel or the timeout hits.
export async function openZeroConfChannelToWallet(
  wallet: LibreListenerWallet,
  nodeId: string,
  lspPubkey: string,
  opts: { localAmtSat: number; pushAmtSat: number },
): Promise<void> {
  let channelReady = false;
  const readyListener = (e: Event) => { if (e.constructor.name === "Event_ChannelReady") channelReady = true; };
  wallet.addEventListener(readyListener);
  await wallet.connectPeer(lspPubkey, "127.0.0.1", 9735);
  await sleep(2000);

  const openPromise = runCmdAsync(
    `${LNCLI} openchannel --node_key ${nodeId} --local_amt ${opts.localAmtSat} --push_amt ${opts.pushAmtSat} --zero_conf --private --channel_type anchors`,
  ).catch(() => {});
  for (let i = 0; i < 40 && !channelReady; i++) await sleep(500);
  wallet.removeEventListener(readyListener);
  for (let i = 0; i < 20 && !(await lndSeesActiveChannel(nodeId)); i++) await sleep(1000);
  await openPromise;
  await sleep(3000);
  if (!channelReady) throw new Error("channel never became ready in setup");
}
