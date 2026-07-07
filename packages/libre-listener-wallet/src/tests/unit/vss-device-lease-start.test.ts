// @vitest-environment node
//
// End-to-end: the cross-device single-instance lease actually gates start(). Two wallets with the
// SAME seed but SEPARATE storage (two "devices") point at one in-process VSS store; the second to
// start must be refused with CrossDeviceLockError, and can start once the first releases. No docker
// (esplora mocked via MSW at tip height 0), no channels — the lease is checked early in start().
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  LibreListenerWallet,
  SecureStorageProvider,
  WebSocketStreamProvider,
  CrossDeviceLockError,
} from "../../index";
import { isCrossDeviceLockError } from "@libre/shared";
import { startVssTestServer, VssTestServer } from "../integration/vss-test-server";
import * as fs from "fs";
import * as path from "path";

function loadWasmBinary(): Uint8Array {
  const paths = [
    path.resolve(__dirname, "../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "../../node_modules/lightningdevkit/liblightningjs.wasm"),
  ];
  for (const p of paths) if (fs.existsSync(p)) return fs.readFileSync(p);
  throw new Error("wasm not found");
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
  return { getItem: async (k) => db.get(k) ?? null, setItem: async (k, v) => { db.set(k, v); }, removeItem: async (k) => { db.delete(k); } };
}

const SAME_SEED = "11".repeat(32); // identical seed on both "devices"

describe("cross-device single-instance lease gates start()", () => {
  let wasmBinary: Uint8Array;
  let vss: VssTestServer;
  beforeAll(async () => {
    wasmBinary = loadWasmBinary();
    mswServer.listen({ onUnhandledRequest: "bypass" }); // let VSS (127.0.0.1) through
    vss = await startVssTestServer();
  }, 60000);
  afterEach(() => mswServer.resetHandlers());
  afterAll(async () => { mswServer.close(); await vss.close(); });

  function device(db: Map<string, string>) {
    return new LibreListenerWallet({
      config: { network: "regtest", esploraUrl, vssUrl: vss.url },
      storage: makeStorage(db),
      socketProvider: noSocket,
      wasmBinary,
    });
  }

  it("refuses the SECOND device (same seed) while the first holds the lease, then allows it after release", async () => {
    const dbA = new Map<string, string>([["ldk_seed", SAME_SEED]]);
    const dbB = new Map<string, string>([["ldk_seed", SAME_SEED]]);

    const deviceA = device(dbA);
    await deviceA.start();
    expect(deviceA.status()).toBe("Running");

    // Second device, same wallet → refused (call start once, inspect the rejection).
    const deviceB = device(dbB);
    const err = await deviceB.start().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(CrossDeviceLockError);
    expect(isCrossDeviceLockError(err)).toBe(true);
    expect(deviceB.status()).not.toBe("Running");

    // First device releases on stop → second device can now take over.
    await deviceA.stop();
    const deviceB2 = device(dbB);
    await deviceB2.start();
    expect(deviceB2.status()).toBe("Running");
    await deviceB2.stop();
  });

  it("enforceSingleDevice:false opts out (no lease check)", async () => {
    const dbA = new Map<string, string>([["ldk_seed", SAME_SEED]]);
    const dbB = new Map<string, string>([["ldk_seed", SAME_SEED]]);
    const a = new LibreListenerWallet({ config: { network: "regtest", esploraUrl, vssUrl: vss.url, enforceSingleDevice: false }, storage: makeStorage(dbA), socketProvider: noSocket, wasmBinary });
    const b = new LibreListenerWallet({ config: { network: "regtest", esploraUrl, vssUrl: vss.url, enforceSingleDevice: false }, storage: makeStorage(dbB), socketProvider: noSocket, wasmBinary });
    await a.start();
    await b.start(); // NOT refused — opted out
    expect(a.status()).toBe("Running");
    expect(b.status()).toBe("Running");
    await a.stop();
    await b.stop();
  });
});
