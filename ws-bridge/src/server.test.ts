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

  it("rejects `ready` when the port is already in use (EADDRINUSE)", async () => {
    const first = startBridge({ port: 0, allowlist: new Set() });
    cleanups.push(first.close);
    const port = await first.ready;

    const second = startBridge({ port, allowlist: new Set() });
    // Swallow the rejection at the promise level too, so a slow assertion
    // failure below can't leave an unhandled rejection lingering.
    second.ready.catch(() => {});
    await expect(second.ready).rejects.toThrow();
    // The second bridge never started listening, so there's nothing to close.
  });

  it("rejects the (N+1)th connection once the global cap is reached (close 1013)", async () => {
    const echo = await startEcho();
    cleanups.push(echo.close);
    const bridge = startBridge({
      port: 0,
      allowlist: new Set([`127.0.0.1:${echo.port}`]),
      allowPrivate: true,
      maxTotalConns: 2,
    });
    cleanups.push(bridge.close);
    const port = await bridge.ready;
    const target = `?target=127.0.0.1:${echo.port}`;

    // Two established connections fill the global cap.
    await connectWs(`ws://127.0.0.1:${port}/${target}`);
    await connectWs(`ws://127.0.0.1:${port}/${target}`);

    // The third is refused with 1013 (server at capacity).
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${target}`);
    cleanups.push(() => ws.close());
    const code = await new Promise<number>((r) => ws.on("close", (c) => r(c)));
    expect(code).toBe(1013);
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
