import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { WebSocket } from "ws";
import { startBridge } from "./server";

// A real TCP echo server (no mocking) the bridge proxies to.
function startEcho(): Promise<{ port: number; close: () => void }> {
  return new Promise((res) => {
    const srv = net.createServer((sock) => sock.pipe(sock));
    srv.listen(0, "127.0.0.1", () => res({ port: (srv.address() as net.AddressInfo).port, close: () => srv.close() }));
  });
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function connectWs(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  cleanups.push(() => ws.close());
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
    ws.on("close", (code) => reject(new Error(`closed ${code}`)));
  });
  return ws;
}

describe("ws-bridge server", () => {
  it("proxies bytes to an allowlisted target and back", async () => {
    const echo = await startEcho();
    cleanups.push(echo.close);
    const bridge = startBridge({ port: 0, allowlist: new Set([`127.0.0.1:${echo.port}`]), allowPrivate: true });
    cleanups.push(bridge.close);
    const port = await bridge.ready;

    const ws = await connectWs(`ws://127.0.0.1:${port}/?target=127.0.0.1:${echo.port}`);
    const got = new Promise<Buffer>((r) => ws.on("message", (d) => r(d as Buffer)));
    ws.send(Buffer.from([1, 2, 3, 4]));
    expect(Array.from(await got)).toEqual([1, 2, 3, 4]);
  });

  it("refuses a non-allowlisted target (close 1008)", async () => {
    const bridge = startBridge({ port: 0, allowlist: new Set(["64.23.162.51:9735"]), allowPrivate: true });
    cleanups.push(bridge.close);
    const port = await bridge.ready;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/?target=1.2.3.4:9999`);
    cleanups.push(() => ws.close());
    const code = await new Promise<number>((r) => ws.on("close", (c) => r(c)));
    expect(code).toBe(1008);
  });

  it("refuses a private target when allowPrivate is off", async () => {
    const echo = await startEcho();
    cleanups.push(echo.close);
    const bridge = startBridge({ port: 0, allowlist: new Set([`127.0.0.1:${echo.port}`]) /* allowPrivate off */ });
    cleanups.push(bridge.close);
    const port = await bridge.ready;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/?target=127.0.0.1:${echo.port}`);
    cleanups.push(() => ws.close());
    const code = await new Promise<number>((r) => ws.on("close", (c) => r(c)));
    expect(code).toBe(1008);
  });

  it("falls back to BRIDGE_TARGET when no ?target is given", async () => {
    const echo = await startEcho();
    cleanups.push(echo.close);
    const bridge = startBridge({
      port: 0,
      allowlist: new Set([`127.0.0.1:${echo.port}`]),
      fallbackTarget: `127.0.0.1:${echo.port}`,
      allowPrivate: true,
    });
    cleanups.push(bridge.close);
    const port = await bridge.ready;

    const ws = await connectWs(`ws://127.0.0.1:${port}/`);
    const got = new Promise<Buffer>((r) => ws.on("message", (d) => r(d as Buffer)));
    ws.send(Buffer.from([9, 9]));
    expect(Array.from(await got)).toEqual([9, 9]);
  });
});
