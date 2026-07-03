// Regression: a channel-less wallet has nothing to hint, so buildInvoice's best-effort hint
// step must be a no-op and the LDK-original invoice must pass through untouched. Mirrors the
// wallet-boot pattern in peer-disconnect-reentrancy.test.ts (jsdom + MSW esplora mock at tip 0
// so start() needs no docker/regtest).
import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup";
import { hasRouteHint } from "../../bolt11-hints";
import {
  LibreListenerWallet,
  SecureStorageProvider,
  WebSocketStreamProvider,
  WebSocketConnection,
} from "../../index";
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
beforeEach(() => {
  server.use(
    http.get(`${ESPLORA}/fee-estimates`, () => HttpResponse.json({})),
    http.get(`${ESPLORA}/blocks/tip/height`, () => HttpResponse.text("0")),
    http.get(`${ESPLORA}/blocks/tip/hash`, () => HttpResponse.text("00".repeat(32))),
  );
});

const storage: SecureStorageProvider = {
  getItem: async () => null,
  setItem: async () => {},
  removeItem: async () => {},
};

const socketProvider: WebSocketStreamProvider = {
  connect: async () => ({ send: () => {}, close: () => {} } as unknown as WebSocketConnection),
};

describe("buildInvoice route-hint wiring", () => {
  it("invoice from a channel-less wallet has no route hints and remains LDK-original", async () => {
    const wallet = new LibreListenerWallet({
      config: { network: "regtest", esploraUrl: ESPLORA },
      storage,
      socketProvider,
      wasmBinary: loadWasmBinary(),
    });
    await wallet.start();

    const invoice = await wallet.createInvoice(1000, "test", 3600);
    expect(hasRouteHint(invoice)).toBe(false); // no channels → nothing to hint, invoice untouched

    await wallet.stop();
  });
});
