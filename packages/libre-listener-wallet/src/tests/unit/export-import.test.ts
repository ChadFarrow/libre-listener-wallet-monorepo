// @vitest-environment node
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { LibreListenerWallet, SecureStorageProvider, WebSocketStreamProvider } from "../../index";
import { bytesToHex } from "../../storage-cache";
import * as fs from "fs";
import * as path from "path";

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

const esploraUrl = "https://mock-esplora.api";
const mswServer = setupServer(
  http.get(`${esploraUrl}/blocks/tip/height`, () => HttpResponse.text("100")),
  http.get(`${esploraUrl}/blocks/tip/hash`, () => HttpResponse.text("00".repeat(32))),
  http.get(`${esploraUrl}/block-height/:height`, () => HttpResponse.text("00".repeat(32))),
  http.get(`${esploraUrl}/block/:hash/header`, () => HttpResponse.text("00".repeat(80))),
  http.get(`${esploraUrl}/fee-estimates`, () => HttpResponse.json({ "1": 10.0, "6": 5.0, "144": 1.0 }))
);

const noSocket: WebSocketStreamProvider = {
  connect: async () => { throw new Error("not used"); },
};

function makeStorage(db: Map<string, string>): SecureStorageProvider {
  return {
    getItem: async (k) => db.get(k) || null,
    setItem: async (k, v) => { db.set(k, v); },
    removeItem: async (k) => { db.delete(k); },
  };
}

describe("LibreListenerWallet export/import round-trip", () => {
  let wasmBinary: Uint8Array;
  beforeAll(() => { wasmBinary = loadWasmBinary(); mswServer.listen({ onUnhandledRequest: "bypass" }); });
  afterEach(() => mswServer.resetHandlers());
  afterAll(() => mswServer.close());

  it("exports encrypted state and restores it into a fresh wallet (same node id)", async () => {
    const config = { network: "regtest" as const, esploraUrl };

    // Wallet A — generates a seed, runs, exports, stops.
    const dbA = new Map<string, string>();
    const walletA = new LibreListenerWallet({ config, storage: makeStorage(dbA), socketProvider: noSocket, wasmBinary });
    await walletA.start();
    const nodeIdA = bytesToHex(walletA.getChannelManager()!.get_our_node_id());
    const seedHex = dbA.get("ldk_seed")!;
    expect(seedHex).toBeDefined();
    const blob = await walletA.exportState();
    await walletA.stop();

    // The blob must be ciphertext, not contain the raw seed.
    expect(blob).not.toContain(seedHex);

    // Wallet B — fresh empty storage, import, start, must boot to the SAME node id.
    const dbB = new Map<string, string>();
    const walletB = new LibreListenerWallet({ config, storage: makeStorage(dbB), socketProvider: noSocket, wasmBinary });
    await walletB.importState(blob, seedHex);
    expect(dbB.has("channel_manager")).toBe(true);
    expect(dbB.get("ldk_seed")).toBe(seedHex);
    await walletB.start();
    const nodeIdB = bytesToHex(walletB.getChannelManager()!.get_our_node_id());
    expect(nodeIdB).toBe(nodeIdA);
    await walletB.stop();
  });

  it("throws when importing while running", async () => {
    const db = new Map<string, string>();
    const wallet = new LibreListenerWallet({ config: { network: "regtest", esploraUrl }, storage: makeStorage(db), socketProvider: noSocket, wasmBinary });
    await wallet.start();
    await expect(wallet.importState("{}", "ab".repeat(32))).rejects.toThrow(/while running/);
    await wallet.stop();
  });

  it("throws if ldk_keys_index is malformed", async () => {
    const db = new Map<string, string>();
    const wallet = new LibreListenerWallet({ config: { network: "regtest", esploraUrl }, storage: makeStorage(db), socketProvider: noSocket, wasmBinary });
    await wallet.start();
    db.set("ldk_keys_index", "{not valid json");
    await expect(wallet.exportState()).rejects.toThrow(/malformed/);
    await wallet.stop();
  });

  it("rejects importing a backup from a different network", async () => {
    // Export from a regtest wallet
    const dbA = new Map<string, string>();
    const wA = new LibreListenerWallet({ config: { network: "regtest", esploraUrl }, storage: makeStorage(dbA), socketProvider: noSocket, wasmBinary });
    await wA.start();
    const seedHex = dbA.get("ldk_seed")!;
    const blob = await wA.exportState();
    await wA.stop();
    // Import into a wallet configured for a different network
    const dbB = new Map<string, string>();
    const wB = new LibreListenerWallet({ config: { network: "testnet", esploraUrl }, storage: makeStorage(dbB), socketProvider: noSocket, wasmBinary });
    await expect(wB.importState(blob, seedHex)).rejects.toThrow(/network mismatch/);
  });
});
