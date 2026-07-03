import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup";
import {
  LibreListenerWallet,
  SecureStorageProvider,
  WebSocketStreamProvider,
  WebSocketConnection,
} from "../../index";
import { decryptAndParse } from "../../state-backup";
import * as fs from "fs";
import * as path from "path";

// Verifies the slim backup: network_graph/scorer (re-derivable, ~20MB) are excluded from the
// backup, yet a slim backup still restores into a fresh wallet AND starts — start() creates a fresh
// graph when none is present (the same path a brand-new wallet takes). Real LDK WASM, esplora mocked
// at tip 0 so the initial sync is a no-op (no docker).

function loadWasmBinary(): Uint8Array {
  const paths = [
    path.resolve(__dirname, "../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "../../node_modules/lightningdevkit/liblightningjs.wasm"),
  ];
  for (const p of paths) if (fs.existsSync(p)) return fs.readFileSync(p);
  throw new Error("Could not find liblightningjs.wasm");
}

const ESPLORA = "http://127.0.0.1:3002";
beforeEach(() => {
  server.use(
    http.get(`${ESPLORA}/fee-estimates`, () => HttpResponse.json({})),
    http.get(`${ESPLORA}/blocks/tip/height`, () => HttpResponse.text("0")),
    http.get(`${ESPLORA}/blocks/tip/hash`, () => HttpResponse.text("00".repeat(32)))
  );
});

function memStorage(): SecureStorageProvider {
  const m = new Map<string, string>();
  return {
    getItem: async (k) => m.get(k) ?? null,
    setItem: async (k, v) => {
      m.set(k, v);
    },
    removeItem: async (k) => {
      m.delete(k);
    },
  };
}

const socketProvider: WebSocketStreamProvider = {
  connect: async () => ({ send: () => {}, close: () => {} } as unknown as WebSocketConnection),
};

function makeWallet(storage: SecureStorageProvider) {
  return new LibreListenerWallet({
    config: { network: "regtest", esploraUrl: ESPLORA },
    storage,
    socketProvider,
    wasmBinary: loadWasmBinary(),
  });
}

describe("slim backup (no network graph)", () => {
  it("omits network_graph/scorer yet restores into a fresh wallet and starts", async () => {
    const storageA = memStorage();
    const walletA = makeWallet(storageA);
    await walletA.start();
    const seedHex = await storageA.getItem("ldk_seed");
    expect(seedHex).toBeTruthy();

    const blob = await walletA.exportState();
    await walletA.stop();

    // The backup carries the irreplaceable state but NOT the re-derivable graph/scorer.
    const payload = await decryptAndParse(blob, seedHex!);
    expect(payload.entries["ldk_seed"]).toBeTruthy();
    expect(payload.entries["channel_manager"]).toBeTruthy();
    expect(payload.entries["network_graph"]).toBeUndefined();
    expect(payload.entries["scorer"]).toBeUndefined();

    // A slim backup still restores + starts (start creates a fresh graph when none is present).
    const storageB = memStorage();
    const walletB = makeWallet(storageB);
    await walletB.importState(blob, seedHex!);
    await walletB.start();
    expect(walletB.status()).toBe("Running");
    await walletB.stop();
  });
});
