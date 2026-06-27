import { describe, it, expect, vi } from "vitest";
import { LndRestClient } from "../lnd-client";

function fakeFetch(routes: Record<string, any>) {
  return vi.fn(async (url: string, init?: any) => {
    const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
    const r = routes[key];
    if (!r) return { ok: false, status: 404, text: async () => "no route " + key } as any;
    return { ok: true, status: 200, json: async () => r, text: async () => JSON.stringify(r) } as any;
  });
}

const cfg = (fetchImpl: any) => ({ restUrl: "https://127.0.0.1:8088", macaroonHex: "deadbeef", fetchImpl });

describe("LndRestClient", () => {
  it("getInfo returns identity_pubkey", async () => {
    const f = fakeFetch({ "GET /v1/getinfo": { identity_pubkey: "02abc" } });
    const c = new LndRestClient(cfg(f));
    expect((await c.getInfo()).identity_pubkey).toBe("02abc");
    expect(f.mock.calls[0][1].headers["Grpc-Metadata-macaroon"]).toBe("deadbeef");
  });

  it("openChannel POSTs the right non-anchor body with macaroon header and resolves void", async () => {
    const f = fakeFetch({
      // Real lnd returns funding_txid_bytes (base64), NOT funding_txid_str
      "POST /v1/channels": { funding_txid_bytes: "base64byteshere=", output_index: 0 },
    });
    const c = new LndRestClient(cfg(f));
    const result = await c.openChannel({ nodePubkeyHex: "03def", localFundingSat: 1000000, pushSat: 200000 });
    // Must resolve void — no fundingTxid/outputIndex returned
    expect(result).toBeUndefined();
    const call = f.mock.calls[0][1];
    expect(call.headers["Grpc-Metadata-macaroon"]).toBe("deadbeef");
    const body = JSON.parse(call.body);
    expect(body.node_pubkey_string).toBe("03def");
    expect(body.local_funding_amount).toBe("1000000");
    expect(body.push_sat).toBe("200000");
    expect(body.private).toBe(true);
    expect(body.commitment_type).toBe("STATIC_REMOTE_KEY");
  });

  it("findChannelScid matches by remote_pubkey and returns chan_id", async () => {
    const f = fakeFetch({
      "GET /v1/channels": {
        channels: [
          // funding_txid_bytes-style point — NOT used for matching
          { remote_pubkey: "03def", channel_point: "aabbcc:0", chan_id: "12345", funding_txid_bytes: "abc=" },
          { remote_pubkey: "0399ff", channel_point: "ddeeff:0", chan_id: "999", funding_txid_bytes: "def=" },
        ],
      },
    });
    const c = new LndRestClient(cfg(f));
    const scid = await c.findChannelScid({ nodePubkeyHex: "03def", delayMs: 0 });
    expect(scid).toBe("12345");
  });

  it("findChannelScid returns the latest (last) match when multiple channels share the pubkey", async () => {
    const f = fakeFetch({
      "GET /v1/channels": {
        channels: [
          { remote_pubkey: "03def", channel_point: "aabb:0", chan_id: "111", funding_txid_bytes: "aaa=" },
          { remote_pubkey: "03def", channel_point: "ccdd:0", chan_id: "222", funding_txid_bytes: "bbb=" },
        ],
      },
    });
    const c = new LndRestClient(cfg(f));
    const scid = await c.findChannelScid({ nodePubkeyHex: "03def", delayMs: 0 });
    expect(scid).toBe("222");
  });

  it("findChannelScid retries and throws after retries exhausted when no match", async () => {
    // Every call returns empty channels — should retry then throw
    const f = fakeFetch({ "GET /v1/channels": { channels: [] } });
    const c = new LndRestClient(cfg(f));
    await expect(
      c.findChannelScid({ nodePubkeyHex: "03def", retries: 2, delayMs: 0 })
    ).rejects.toThrow(/no channel to 03def found in listchannels after 3 tries/);
    // retries=2 means 1 initial + 2 retries = 3 total fetches
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("throws with lnd error text on non-2xx", async () => {
    const f = vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" }) as any);
    const c = new LndRestClient(cfg(f));
    await expect(c.getInfo()).rejects.toThrow(/lnd REST 500: boom/);
  });
});
