// @vitest-environment node
//
// Validates the full VSS stack locally WITHOUT docker: the real VssClient talking protobuf-over-HTTP
// to the in-memory VssTestServer, exercising both directions of the vss-protobuf codec. This is the
// same server the docker VSS-recovery soak uses, so proving it here means the soak's VSS half is sound.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startVssTestServer, VssTestServer } from "../integration/vss-test-server";
import { VssClient, isVssConflict } from "../../vss-client";

let server: VssTestServer;
const client = () => new VssClient({ baseUrl: server.url, storeId: "wallet-1" });

describe("VSS client <-> in-memory server", () => {
  beforeAll(async () => { server = await startVssTestServer(); });
  afterAll(async () => { await server.close(); });

  it("round-trips a value: put then get returns the same bytes", async () => {
    const value = new TextEncoder().encode("encrypted-envelope-bytes");
    await client().putObjects([{ key: "state_backup", version: 0, value }]);
    const got = await client().getObject("state_backup");
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got!.value)).toBe("encrypted-envelope-bytes");
    expect(got!.version).toBe(1); // server bumped 0 -> 1
  });

  it("returns null for a missing key", async () => {
    expect(await client().getObject("does-not-exist")).toBeNull();
  });

  it("blind write (version -1) overwrites regardless of current version", async () => {
    await client().putObjects([{ key: "bw", version: 0, value: Uint8Array.from([1]) }]);
    // A blind write must succeed even though the server's current version is now 1.
    await client().putObjects([{ key: "bw", version: -1, value: Uint8Array.from([2, 2]) }]);
    const got = await client().getObject("bw");
    expect(Array.from(got!.value)).toEqual([2, 2]);
  });

  it("rejects a stale non-negative version with a conflict", async () => {
    await client().putObjects([{ key: "cc", version: 0, value: Uint8Array.from([9]) }]); // -> version 1
    let thrown: unknown;
    try {
      // Sending version 0 again is stale (server is at 1) -> ConflictException.
      await client().putObjects([{ key: "cc", version: 0, value: Uint8Array.from([8]) }]);
    } catch (e) {
      thrown = e;
    }
    expect(isVssConflict(thrown)).toBe(true);
  });

  it("listAllKeyVersions enumerates keys with versions (values omitted)", async () => {
    const c = new VssClient({ baseUrl: server.url, storeId: "list-store" });
    await c.putObjects([{ key: "tx_a", version: 0, value: Uint8Array.from([1]) }]);
    await c.putObjects([{ key: "tx_b", version: 0, value: Uint8Array.from([2]) }]);
    const all = await c.listAllKeyVersions("tx_");
    const byKey = Object.fromEntries(all.map((k) => [k.key, k.version]));
    expect(byKey).toEqual({ tx_a: 1, tx_b: 1 });
    expect(all.every((k) => k.value.length === 0)).toBe(true);
  });

  it("isolates stores by storeId", async () => {
    const a = new VssClient({ baseUrl: server.url, storeId: "store-A" });
    const b = new VssClient({ baseUrl: server.url, storeId: "store-B" });
    await a.putObjects([{ key: "k", version: 0, value: Uint8Array.from([1]) }]);
    expect(await b.getObject("k")).toBeNull(); // B can't see A's key
  });
});
