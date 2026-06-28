import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LibreNWCPushGateway } from "../../index";

// The RGS proxy lets a browser fetch LDK Rapid Gossip Sync snapshots, which are
// otherwise CORS-blocked against rapidsync.lightningdevkit.org. The gateway fetches
// upstream server-side and re-serves with CORS headers.
//
// We intercept ONLY the upstream RGS host on globalThis.fetch and pass everything
// else (including this test's own calls to the local gateway) through to real fetch.
const UPSTREAM = "https://rapidsync.lightningdevkit.org/snapshot/";
const SNAPSHOT_BYTES = new Uint8Array([0x52, 0x47, 0x53, 0x00, 0x01, 0x02, 0xff]);

describe("RGS CORS proxy", () => {
  let gateway: LibreNWCPushGateway;
  const PORT = 3098;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    globalThis.fetch = ((input: any, init?: any) => {
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      if (url.startsWith(UPSTREAM)) {
        const ts = url.slice(UPSTREAM.length);
        if (ts === "999") return Promise.resolve(new Response(null, { status: 404 }));
        return Promise.resolve(
          new Response(SNAPSHOT_BYTES, {
            status: 200,
            headers: { "Content-Type": "application/octet-stream" },
          })
        );
      }
      return realFetch(input, init);
    }) as typeof fetch;

    gateway = new LibreNWCPushGateway({ host: "127.0.0.1", port: PORT, dbPath: ":memory:" });
    await gateway.start();
  });

  afterAll(async () => {
    await gateway.stop();
    globalThis.fetch = realFetch;
  });

  it("passes the upstream snapshot bytes through unchanged", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/rgs/snapshot/0`);
    expect(res.status).toBe(200);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual(Array.from(SNAPSHOT_BYTES));
  });

  it("serves the snapshot with a permissive CORS header", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/rgs/snapshot/0`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("forwards an upstream non-200 status", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/rgs/snapshot/999`);
    expect(res.status).toBe(404);
  });

  it("rejects a non-numeric timestamp with 400", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/rgs/snapshot/not-a-number`);
    expect(res.status).toBe(400);
  });
});
