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
// A fresh node built at tip height 0 makes the initial sync a no-op, so start() needs
// only these three esplora reads mocked — no docker/regtest.
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

// The peer never answers, so its noise handshake never completes — which is exactly what
// makes LDK's periodic tick decide it's dead and disconnect it.
const socketProvider: WebSocketStreamProvider = {
  connect: async () => ({ send: () => {}, close: () => {} } as unknown as WebSocketConnection),
};

const PEER = "028ea4e01d6f7e6d80d2d6902eda9304c4bcda78a6abfda3dee2de94ef46a302d5";

async function makeStartedWallet() {
  const wallet = new LibreListenerWallet({
    config: { network: "regtest", esploraUrl: ESPLORA },
    storage,
    socketProvider,
    wasmBinary: loadWasmBinary(),
  });
  await wallet.start();
  return wallet;
}

describe("peer disconnect re-entrancy", () => {
  // Regression: LDK's timer_tick_occurred() disconnects a stale peer by calling our
  // SocketDescriptor.disconnect_socket() *re-entrantly*. If our handler calls back into
  // PeerManager (socket_disconnected/process_events) synchronously, WASM panics with
  // "already borrowed: BorrowMutError" -> RuntimeError: unreachable, which on the minified
  // PWA surfaces as "attempt N failed: unreachable executed" and kills auto-reconnect
  // forever (the channel goes offline and never recovers without a page reload).
  it("does not crash when LDK disconnects a stale peer on the periodic tick", async () => {
    const wallet = await makeStartedWallet();
    await wallet.connectPeer(PEER, "127.0.0.1", 9735);
    const pm = (wallet as any).peerManager;

    expect(() => {
      for (let i = 0; i < 5; i++) {
        pm.timer_tick_occurred();
        pm.process_events();
      }
    }).not.toThrow();

    // The dead peer was dropped from the connected set.
    expect((wallet as any).connectedPeers.has(PEER)).toBe(false);

    await wallet.stop();
  });

  it("can reconnect the peer after LDK tore it down (PeerManager state not corrupted)", async () => {
    const wallet = await makeStartedWallet();
    await wallet.connectPeer(PEER, "127.0.0.1", 9735);
    const pm = (wallet as any).peerManager;

    for (let i = 0; i < 5; i++) {
      pm.timer_tick_occurred();
      pm.process_events();
    }

    // Let any deferred LDK notifications flush, then redial — this is the call that
    // panicked "unreachable executed" on every attempt in production.
    await new Promise((r) => setTimeout(r, 0));
    await expect(wallet.connectPeer(PEER, "127.0.0.1", 9735)).resolves.toBeUndefined();
    expect((wallet as any).connectedPeers.has(PEER)).toBe(true);

    await wallet.stop();
  });
});
