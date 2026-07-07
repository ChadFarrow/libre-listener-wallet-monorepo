// @vitest-environment node
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  LibreListenerWallet,
  SecureStorageProvider,
  WebSocketStreamProvider,
  ChannelStateRegressionError,
} from "../../index";
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
  http.get(`${esploraUrl}/blocks/tip/height`, () => HttpResponse.text("0")),
  http.get(`${esploraUrl}/blocks/tip/hash`, () => HttpResponse.text("00".repeat(32))),
  http.get(`${esploraUrl}/block-height/:height`, () => HttpResponse.text("00".repeat(32))),
  http.get(`${esploraUrl}/block/:hash/header`, () => HttpResponse.text("00".repeat(80))),
  http.get(`${esploraUrl}/fee-estimates`, () => HttpResponse.json({ "1": 10, "6": 5, "144": 1 })),
);
const noSocket: WebSocketStreamProvider = { connect: async () => { throw new Error("not used"); } };
function makeStorage(db: Map<string, string>): SecureStorageProvider {
  return {
    getItem: async (k) => db.get(k) ?? null,
    setItem: async (k, v) => { db.set(k, v); },
    removeItem: async (k) => { db.delete(k); },
  };
}
const HW_KEY = "monitor_update_highwater";

describe("channel-state regression guard", () => {
  let wasmBinary: Uint8Array;
  beforeAll(() => { wasmBinary = loadWasmBinary(); mswServer.listen({ onUnhandledRequest: "bypass" }); });
  afterEach(() => mswServer.resetHandlers());
  afterAll(() => mswServer.close());

  it("fresh wallet starts and writes an (empty) marker — export omits it", async () => {
    const db = new Map<string, string>();
    const wallet = new LibreListenerWallet({ config: { network: "regtest", esploraUrl }, storage: makeStorage(db), socketProvider: noSocket, wasmBinary });
    await wallet.start();
    expect(wallet.status()).toBe("Running");
    expect(db.get(HW_KEY)).toBe("{}");
    const blob = await wallet.exportState();
    // marker is non-critical → must NOT be in the backup
    const { decryptAndParse } = await import("../../state-backup");
    const payload = await decryptAndParse(blob, db.get("ldk_seed")!);
    expect(payload.entries[HW_KEY]).toBeUndefined();
    await wallet.stop();
  });

  it("does NOT false-halt on a high-water entry for a channel with no loaded monitor", async () => {
    const db = new Map<string, string>();
    db.set(HW_KEY, JSON.stringify({ [("aa".repeat(32))]: "9" })); // stale entry, no such monitor
    const wallet = new LibreListenerWallet({ config: { network: "regtest", esploraUrl }, storage: makeStorage(db), socketProvider: noSocket, wasmBinary });
    await expect(wallet.start()).resolves.toBeUndefined();
    expect(wallet.status()).toBe("Running");
    await wallet.stop();
  });

  it("importState clears any stale marker (a restore is authoritative)", async () => {
    // Produce a real slim backup from a fresh wallet.
    const dbA = new Map<string, string>();
    const walletA = new LibreListenerWallet({ config: { network: "regtest", esploraUrl }, storage: makeStorage(dbA), socketProvider: noSocket, wasmBinary });
    await walletA.start();
    const seed = dbA.get("ldk_seed")!;
    const blob = await walletA.exportState();
    await walletA.stop();

    const dbB = new Map<string, string>();
    dbB.set(HW_KEY, JSON.stringify({ [("bb".repeat(32))]: "42" })); // stale marker in destination
    // Also seed unrelated non-marker keys: the clear must run regardless of write order, so a
    // crash mid-restore can't leave a stale high-water. These keys are overwritten by the restore.
    dbB.set("rgs_timestamp", "12345");
    dbB.set("state_version", "7");
    dbB.set("peer_addresses", "{}");
    const walletB = new LibreListenerWallet({ config: { network: "regtest", esploraUrl }, storage: makeStorage(dbB), socketProvider: noSocket, wasmBinary });
    await walletB.importState(blob, seed);
    expect(dbB.get(HW_KEY)).toBeUndefined(); // cleared by importState (before any entry writes)
    await walletB.start(); // and no regression on the restored (empty) monitor set
    expect(walletB.status()).toBe("Running");
    await walletB.stop();
  });

  it("exports the error type from the barrel", () => {
    expect(typeof ChannelStateRegressionError).toBe("function");
  });
});
