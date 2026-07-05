// Regression: duplicate peer connections. Two concurrent connectPeer() calls to the same
// pubkey (e.g. the app's auto-start redial racing the SDK's redialChannelPeers on startup)
// both passed the "already connected" check, opened two sockets, and the duplicate's
// registration OVERWROTE the healthy descriptor in connectedPeers. LDK then killed the
// duplicate ("Got second connection with <peer>, closing"), handleDisconnect deleted the
// map entry — orphaning the original, still-live connection — and the reconnect loop
// dialed a fresh duplicate every second, forever (peer count flapping 1↔2 while the
// channel stayed usable). Seen live on mainnet 2026-07-05.
import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup";
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

const PEER = "028ea4e01d6f7e6d80d2d6902eda9304c4bcda78a6abfda3dee2de94ef46a302d5";

describe("concurrent connectPeer dial dedup", () => {
  it("opens only one socket when two dials to the same peer race", async () => {
    let connects = 0;
    // Delay connect a tick so both calls are in flight together (the TOCTOU window).
    const socketProvider: WebSocketStreamProvider = {
      connect: async () => {
        connects++;
        await new Promise((r) => setTimeout(r, 20));
        return { send: () => {}, close: () => {} } as unknown as WebSocketConnection;
      },
    };
    const wallet = new LibreListenerWallet({
      config: { network: "regtest", esploraUrl: ESPLORA },
      storage,
      socketProvider,
      wasmBinary: loadWasmBinary(),
    });
    await wallet.start();
    try {
      await Promise.all([
        wallet.connectPeer(PEER, "127.0.0.1", 9735),
        wallet.connectPeer(PEER, "127.0.0.1", 9735),
      ]);
      expect(connects).toBe(1);
      expect(wallet.getConnectedPeers()).toContain(PEER);
      // And a third call after settling is the plain already-connected no-op.
      await wallet.connectPeer(PEER, "127.0.0.1", 9735);
      expect(connects).toBe(1);
    } finally {
      await wallet.stop();
    }
  });
});
