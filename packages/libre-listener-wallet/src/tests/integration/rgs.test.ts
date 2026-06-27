// @vitest-environment node
//
// Real-network test: syncs the ACTUAL mainnet Lightning gossip graph via Rapid Gossip
// Sync and confirms the NetworkGraph populates — which is what enables multi-hop routing
// (boosting a podcaster you're not directly channeled to). Needs internet; chain sync is
// MSW-mocked (we only care about the gossip graph here, not the chain).
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { LibreListenerWallet, SecureStorageProvider, WebSocketStreamProvider } from "../../index";
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
// MSW mocks the chain backend; the real RGS fetch passes through (onUnhandledRequest: bypass).
const mswServer = setupServer(
  http.get(`${esploraUrl}/blocks/tip/height`, () => HttpResponse.text("100")),
  http.get(`${esploraUrl}/blocks/tip/hash`, () => HttpResponse.text("00".repeat(32))),
  http.get(`${esploraUrl}/block-height/:height`, () => HttpResponse.text("00".repeat(32))),
  http.get(`${esploraUrl}/block/:hash/header`, () => HttpResponse.text("00".repeat(80))),
  http.get(`${esploraUrl}/fee-estimates`, () => HttpResponse.json({ "1": 10.0, "6": 5.0, "144": 1.0 }))
);

const noSocket: WebSocketStreamProvider = { connect: async () => { throw new Error("not used"); } };
function makeStorage(db: Map<string, string>): SecureStorageProvider {
  return {
    getItem: async (k) => db.get(k) ?? null,
    setItem: async (k, v) => { db.set(k, v); },
    removeItem: async (k) => { db.delete(k); },
  };
}

describe("Rapid Gossip Sync", () => {
  let wasmBinary: Uint8Array;
  beforeAll(() => { wasmBinary = loadWasmBinary(); mswServer.listen({ onUnhandledRequest: "bypass" }); });
  afterEach(() => mswServer.resetHandlers());
  afterAll(() => mswServer.close());

  it("populates the network graph from the real mainnet RGS, enabling multi-hop routing", async () => {
    const db = new Map<string, string>();
    const wallet = new LibreListenerWallet({
      config: {
        network: "mainnet",
        esploraUrl,
        rapidGossipSyncUrl: "https://rapidsync.lightningdevkit.org/snapshot",
      },
      storage: makeStorage(db),
      socketProvider: noSocket,
      wasmBinary,
    });
    await wallet.start();

    // A fresh wallet's graph is empty — only a gossip sync can populate it.
    await wallet.syncGossip();

    const readOnly = wallet.getNetworkGraph()!.read_only();
    const channels = readOnly.list_channels().length;
    readOnly.free(); // ReadOnlyNetworkGraph holds a read lock that must be freed.
    expect(channels).toBeGreaterThan(1000); // mainnet has tens of thousands of public channels
    // The sync timestamp was recorded so the next sync is incremental.
    expect(Number(db.get("rgs_timestamp"))).toBeGreaterThan(0);

    await wallet.stop();
  }, 60000);
});
