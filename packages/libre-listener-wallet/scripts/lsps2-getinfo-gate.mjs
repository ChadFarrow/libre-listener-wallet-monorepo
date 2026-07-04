// LSPS2 Gate-1: does a real mainnet LSP answer lsps2.get_info over BOLT8 peer-msg 37913?
//
// Boots a throwaway in-memory-storage wallet on mainnet, connects to each LSP through the
// deployed ws-bridge, and prints its LSPS2 fee menu (or records that it didn't answer).
// Spends no sats. See README-lsps2-gate.md for prerequisites and how to read the result.
//
// Run (from this package's directory, AFTER `pnpm build`):
//   node scripts/lsps2-getinfo-gate.mjs
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";

import { LibreListenerWallet } from "../dist/index.mjs";
import { bridgeTargetUrl } from "@libre/shared";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const __dirname = dirname(fileURLToPath(import.meta.url));

const BRIDGE = "wss://ws-bridge-production-9e2f.up.railway.app";
const ESPLORA = "https://mempool.space/api";
const LSPS = [
  {
    name: "Megalith",
    pubkey: "038a9e56512ec98da2b5789761f7af8f280baf98a09282360cd6ff1381b5e889bf",
    host: "64.23.162.51",
    port: 9735,
  },
  {
    name: "Olympus",
    pubkey: "031b301307574bbe9b9ac7b79cbe1700e31e544513eae0b5d7497483083f99e581",
    host: "45.79.192.236",
    port: 9735,
  },
];

// LDK WASM binary lives in this package's own node_modules (pnpm hoists lightningdevkit here).
function loadWasmBinary() {
  const p = resolve(__dirname, "../node_modules/lightningdevkit/liblightningjs.wasm");
  return readFileSync(p);
}

// Minimal in-memory SecureStorageProvider — nothing persists across runs, and nothing here
// ever needs to (this node is thrown away at process exit; the LSP connection is read-only).
const mem = new Map();
const storage = {
  getItem: async (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: async (k, v) => void mem.set(k, v),
  removeItem: async (k) => void mem.delete(k),
};

// WebSocketStreamProvider: dial the deployed ws-bridge, appending ?target=host:port the same
// way the browser/extension transports do (see bridgeTargetUrl in @libre/shared). Node 22 has a
// global WebSocket, so no ws package dependency is needed.
const socketProvider = {
  connect: async (address, port) => {
    const url = bridgeTargetUrl(BRIDGE, address, port);
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const conn = {
      send: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      },
      close: () => ws.close(),
    };
    ws.onmessage = (event) => conn.onmessage?.(new Uint8Array(event.data));
    ws.onclose = () => conn.onclose?.();
    return new Promise((resolvePromise, reject) => {
      ws.onopen = () => resolvePromise(conn);
      ws.onerror = () => {
        if (ws.readyState === WebSocket.OPEN) {
          conn.onerror?.(new Error("ws error"));
        } else {
          reject(new Error(`bridge connect failed for ${address}:${port}`));
        }
      };
    });
  },
};

const logger = {
  info: (m, ...a) => console.log("[i]", m, ...a),
  warn: (m, ...a) => console.warn("[w]", m, ...a),
  error: (m, ...a) => console.error("[e]", m, ...a),
};

async function main() {
  const wallet = new LibreListenerWallet({
    config: {
      network: "mainnet",
      esploraUrl: ESPLORA,
    },
    storage,
    socketProvider,
    logger,
    wasmBinary: loadWasmBinary(),
  });

  console.log("Starting throwaway mainnet node (in-memory storage, spends nothing)...");
  await wallet.start();

  for (const lsp of LSPS) {
    console.log(`\nConnecting to ${lsp.name} (${lsp.pubkey}@${lsp.host}:${lsp.port}) via bridge...`);
    try {
      const info = await wallet.getLSPS2Info({
        lspPubkey: lsp.pubkey,
        lspHost: lsp.host,
        lspPort: lsp.port,
      });
      console.log(`\n=== ${lsp.name}: LSPS2 SUPPORTED ✓ ===`);
      console.log("  min_payment_size_msat:", info.min_payment_size_msat);
      console.log("  max_payment_size_msat:", info.max_payment_size_msat);
      console.log("  opening_fee_params_menu:", JSON.stringify(info.opening_fee_params_menu, null, 2));
    } catch (e) {
      console.log(`\n=== ${lsp.name}: NO LSPS2 (or timeout/error) — ${e instanceof Error ? e.message : String(e)} ===`);
    }
  }

  await wallet.stop();
  process.exit(0);
}

main().catch((e) => {
  console.error("Gate script failed:", e);
  process.exit(1);
});
