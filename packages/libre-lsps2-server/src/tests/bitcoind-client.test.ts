import { describe, it, expect, vi } from "vitest";
import { BitcoindClient } from "../bitcoind-client";

describe("BitcoindClient", () => {
  it("mineBlocks generates N blocks to the fixed mine address (no getnewaddress)", async () => {
    const calls: any[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push(body.method);
      return { ok: true, status: 200, json: async () => ({ result: ["hash1", "hash2", "hash3"], error: null }), text: async () => "" } as any;
    });
    const c = new BitcoindClient({ rpcUrl: "http://127.0.0.1:18443", user: "libre", pass: "listener", mineAddress: "bcrt1qmine", fetchImpl });
    await c.mineBlocks(3);
    expect(calls).toEqual(["generatetoaddress"]); // never calls getnewaddress (needs a loaded wallet)
    const genBody = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(genBody.params).toEqual([3, "bcrt1qmine"]);
  });

  it("throws on bitcoind error", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: null, error: { message: "bad" } }) }) as any);
    const c = new BitcoindClient({ rpcUrl: "http://x", user: "u", pass: "p", mineAddress: "bcrt1qmine", fetchImpl });
    await expect(c.mineBlocks(1)).rejects.toThrow(/bitcoind: bad/);
  });
});
