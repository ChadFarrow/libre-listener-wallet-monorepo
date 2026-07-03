// Regression: a channel-less wallet has nothing to hint, so buildInvoice's best-effort hint
// step must be a no-op and the LDK-original invoice must pass through untouched. Mirrors the
// wallet-boot pattern in peer-disconnect-reentrancy.test.ts (jsdom + MSW esplora mock at tip 0
// so start() needs no docker/regtest).
import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup";
import { hasRouteHint } from "../../bolt11-hints";
import { forwardingInfoFromLdk } from "../../hint-selection";
import {
  LibreListenerWallet,
  SecureStorageProvider,
  WebSocketStreamProvider,
  WebSocketConnection,
} from "../../index";
import { ChannelCounterparty, CounterpartyForwardingInfo, InitFeatures, Option_u64Z } from "lightningdevkit";
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

  // Reproduces the reviewer's finding directly against real LDK WASM (not a fake): construct a
  // real ChannelCounterparty with forwarding_info = null. In the installed lightningdevkit 0.1.0
  // bindings, get_forwarding_info() still returns a truthy CounterpartyForwardingInfo wrapper
  // (a null-pointer one) rather than a JS null/undefined — so a naive `fwd ? ... : undefined`
  // check is dead code and forwardingInfoFromLdk must detect the null pointer itself.
  it("a real LDK ChannelCounterparty with forwarding_info=null yields a truthy wrapper whose forwardingInfoFromLdk() is undefined", async () => {
    // Start (and immediately stop) a wallet purely to initialize the LDK WASM module, mirroring
    // the wallet-boot pattern above — the LDK struct constructors below require it.
    const wallet = new LibreListenerWallet({
      config: { network: "regtest", esploraUrl: ESPLORA },
      storage,
      socketProvider,
      wasmBinary: loadWasmBinary(),
    });
    await wallet.start();

    const counterparty = ChannelCounterparty.constructor_new(
      new Uint8Array(33).fill(2), // dummy compressed-pubkey-shaped node id
      InitFeatures.constructor_empty(),
      0n,
      null, // forwarding_info: None
      Option_u64Z.constructor_none(),
      Option_u64Z.constructor_none(),
    );
    const fwd = counterparty.get_forwarding_info();

    expect(fwd).toBeTruthy(); // the trap: LDK's None still surfaces as a truthy JS wrapper
    expect(fwd).toBeInstanceOf(CounterpartyForwardingInfo);
    expect(forwardingInfoFromLdk(fwd)).toBeUndefined(); // our guard must see through it

    await wallet.stop();
  });
});
