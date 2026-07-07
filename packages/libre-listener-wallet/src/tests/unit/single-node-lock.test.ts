// @vitest-environment node
import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { LibreListenerWallet, SecureStorageProvider, WebSocketStreamProvider, NodeAlreadyRunningError } from "../../index";
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

describe("single-node lock (acquireRunLock)", () => {
  let wasmBinary: Uint8Array;
  beforeAll(() => { wasmBinary = loadWasmBinary(); mswServer.listen({ onUnhandledRequest: "bypass" }); });
  afterEach(() => mswServer.resetHandlers());
  afterAll(() => mswServer.close());

  it("throws NodeAlreadyRunningError and does not start when the lock is held", async () => {
    const acquireRunLock = vi.fn().mockResolvedValue(null); // held elsewhere
    const wallet = new LibreListenerWallet({ config: { network: "regtest", esploraUrl }, storage: makeStorage(new Map()), socketProvider: noSocket, wasmBinary, acquireRunLock });
    await expect(wallet.start()).rejects.toBeInstanceOf(NodeAlreadyRunningError);
    expect(wallet.status()).not.toBe("Running");
    expect(acquireRunLock).toHaveBeenCalledTimes(1);
  });

  it("starts when the lock is free and releases it on stop", async () => {
    const release = vi.fn();
    const acquireRunLock = vi.fn().mockResolvedValue(release);
    const wallet = new LibreListenerWallet({ config: { network: "regtest", esploraUrl }, storage: makeStorage(new Map()), socketProvider: noSocket, wasmBinary, acquireRunLock });
    await wallet.start();
    expect(wallet.status()).toBe("Running");
    expect(release).not.toHaveBeenCalled();
    await wallet.stop();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the lock if start() fails after acquiring it", async () => {
    const release = vi.fn();
    const acquireRunLock = vi.fn().mockResolvedValue(release);
    // Force a downstream start failure: a stored channel_manager that fails to decode makes start() throw.
    const db = new Map<string, string>([["channel_manager", "00"], ["ldk_seed", "11".repeat(32)]]);
    const wallet = new LibreListenerWallet({ config: { network: "regtest", esploraUrl }, storage: makeStorage(db), socketProvider: noSocket, wasmBinary, acquireRunLock });
    await expect(wallet.start()).rejects.toBeTruthy();
    expect(release).toHaveBeenCalledTimes(1); // lock freed so a retry/fresh instance can acquire
  });

  it("NodeAlreadyRunningError carries the boundary-stable code + message token", () => {
    const e = new NodeAlreadyRunningError();
    expect(e.code).toBe("NODE_ALREADY_RUNNING");
    expect(e.message).toContain("NODE_ALREADY_RUNNING");
  });
});
