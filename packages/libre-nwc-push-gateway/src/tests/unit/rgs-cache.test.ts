import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LibreNWCPushGateway } from "../../index";

// The RGS passthrough caches upstream snapshots by (validated) timestamp for a
// short TTL so a burst of browser fetches doesn't re-hit rapidsync.lightningdevkit.org.
// This test proves a second request within the TTL is served from cache (fetch not
// called again).
const UPSTREAM = "https://rapidsync.lightningdevkit.org/snapshot/";
const SNAPSHOT_BYTES = new Uint8Array([0x52, 0x47, 0x53, 0x00, 0x01, 0x02, 0xff]);

describe("RGS passthrough cache", () => {
  let gateway: LibreNWCPushGateway;
  const PORT = 3093;
  const realFetch = globalThis.fetch;
  let upstreamCalls = 0;

  beforeAll(async () => {
    upstreamCalls = 0;
    globalThis.fetch = ((input: any, init?: any) => {
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      if (url.startsWith(UPSTREAM)) {
        upstreamCalls++;
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

  it("serves a repeated timestamp from cache without re-fetching upstream", async () => {
    const first = await fetch(`http://127.0.0.1:${PORT}/rgs/snapshot/42`);
    expect(first.status).toBe(200);
    expect(Array.from(new Uint8Array(await first.arrayBuffer()))).toEqual(Array.from(SNAPSHOT_BYTES));
    expect(upstreamCalls).toBe(1);

    const second = await fetch(`http://127.0.0.1:${PORT}/rgs/snapshot/42`);
    expect(second.status).toBe(200);
    expect(Array.from(new Uint8Array(await second.arrayBuffer()))).toEqual(Array.from(SNAPSHOT_BYTES));
    // Still 1 — the second request hit the in-memory cache, not upstream.
    expect(upstreamCalls).toBe(1);
  });
});
