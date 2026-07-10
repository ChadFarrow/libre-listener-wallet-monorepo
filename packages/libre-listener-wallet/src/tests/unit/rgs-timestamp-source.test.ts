import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup";
import { LibreListenerWallet, SecureStorageProvider } from "../../index";
import * as fs from "fs";
import * as path from "path";

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
const RGS = "http://127.0.0.1:9990/rgs";
const requested: string[] = [];

beforeEach(() => {
  requested.length = 0;
  server.use(
    http.get(`${ESPLORA}/fee-estimates`, () => HttpResponse.json({})),
    http.get(`${ESPLORA}/blocks/tip/height`, () => HttpResponse.text("0")),
    http.get(`${ESPLORA}/blocks/tip/hash`, () => HttpResponse.text("00".repeat(32))),
    http.get(`${RGS}/:ts`, ({ params }) => {
      requested.push(String(params.ts));
      // Garbage bytes — the apply fails, but the requested timestamp is what's under test.
      return HttpResponse.arrayBuffer(new Uint8Array([1, 2, 3, 4]).buffer);
    })
  );
});

// Regression (mainnet 2026-07-09): the RGS fetch timestamp came from a standalone storage key
// while the graph itself only persisted on a clean stop() — a tab reload loaded a FRESH graph
// alongside the surviving timestamp, so the sync applied a delta to emptiness and the router had
// "0 nodes and 0 channels": every multi-hop boost failed RouteNotFound. The timestamp must come
// from the graph itself, and an empty graph must always fetch the FULL snapshot (/0).
describe("RGS timestamp source", () => {
  it("fetches the full snapshot for a fresh graph even when a stale rgs_timestamp key survives", async () => {
    const db = new Map<string, string>([["rgs_timestamp", "1783641600"]]);
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
      config: { network: "regtest", esploraUrl: ESPLORA, rapidGossipSyncUrl: RGS },
      storage,
      socketProvider: { connect: async () => ({ send: () => {}, close: () => {} }) as any },
      wasmBinary: loadWasmBinary(),
    });
    await wallet.start();
    await wallet.syncGossip().catch(() => {
      /* garbage snapshot — apply failure is expected; the URL is what matters */
    });
    expect(requested.length).toBeGreaterThan(0);
    for (const ts of requested) expect(ts).toBe("0");
    await wallet.stop();
  });
});
