// iOS foreground-resume peer refresh. On iOS a backgrounded PWA is frozen and the OS can kill the
// bridge socket without an onclose — a "zombie" half-open connection LDK still lists as connected,
// so a send stalls for ~10-20s until the ping-timeout heals it. refreshPeerConnections() collapses
// that window by force-dropping each desired peer's socket and redialing. A plain reconnect can't
// do this: connectPeer early-returns when the peer still looks connected, so the refresh MUST drop
// first. Real LDK WASM + a mock transport (no docker) — we assert the old socket is closed and a
// fresh dial happens.
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

describe("refreshPeerConnections (iOS resume zombie-socket fix)", () => {
  it("force-drops the current socket and redials each desired peer", async () => {
    const sockets: { closed: boolean }[] = [];
    let connects = 0;
    const socketProvider: WebSocketStreamProvider = {
      connect: async () => {
        connects++;
        const c: any = { closed: false, send: () => {}, close: () => { c.closed = true; } };
        sockets.push(c);
        return c as WebSocketConnection;
      },
    };
    const wallet = new LibreListenerWallet({
      config: { network: "regtest", esploraUrl: ESPLORA },
      storage,
      socketProvider,
      wasmBinary: loadWasmBinary(),
    });
    await wallet.start();
    await wallet.connectPeer(PEER, "127.0.0.1", 9735);
    expect(connects).toBe(1);
    expect(wallet.getConnectedPeers()).toContain(PEER);

    await wallet.refreshPeerConnections();
    await new Promise((r) => setTimeout(r, 40)); // let the fire-and-forget redial settle

    expect(sockets[0].closed, "the old (possibly zombie) socket is force-closed").toBe(true);
    expect(connects, "a fresh socket is dialed").toBe(2);

    await wallet.stop();
  });

  it("is a no-op with no desired peers (nothing to refresh)", async () => {
    let connects = 0;
    const socketProvider: WebSocketStreamProvider = {
      connect: async () => {
        connects++;
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
    await wallet.refreshPeerConnections(); // no peers connected yet
    expect(connects).toBe(0);
    await wallet.stop();
  });
});
