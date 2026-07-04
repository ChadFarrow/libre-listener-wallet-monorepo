import { describe, it, expect } from "vitest";
import { Lsps1RestClient, clampExpiryBlocks, isOrderComplete, isOrderFailed, orderInvoice } from "../../lsps1-rest-client";

const GET_INFO = {
  min_channel_balance_sat: "150000",
  max_channel_balance_sat: "16000000",
  max_channel_expiry_blocks: 13140,
  min_required_channel_confirmations: 0,
  supports_zero_channel_reserve: true,
  uris: ["038a9e56@64.23.162.51:9735"],
};
const ORDER = {
  order_id: "abc-123",
  order_state: "CREATED",
  payment: { bolt11: { invoice: "lnbc1...", fee_total_sat: "9126" } },
  channel: null,
};

// Fake fetch that records calls and dispatches by URL substring.
function fakeFetch(byPath: Record<string, unknown>) {
  const calls: { url: string; method: string; body?: any }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
    const path = Object.keys(byPath).find((p) => url.includes(p))!;
    return new Response(JSON.stringify(byPath[path]), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("clampExpiryBlocks", () => {
  it("defaults to the LSP max when unspecified", () => {
    expect(clampExpiryBlocks(undefined, 13140)).toBe(13140);
  });
  it("clamps a too-large request down to max and a too-small one up to 1", () => {
    expect(clampExpiryBlocks(99999, 13140)).toBe(13140);
    expect(clampExpiryBlocks(0, 13140)).toBe(1);
  });
  it("passes a valid request through", () => {
    expect(clampExpiryBlocks(4320, 13140)).toBe(4320);
  });
});

describe("order-state helpers", () => {
  it("reads completion / failure / invoice", () => {
    expect(isOrderComplete({ ...ORDER, order_state: "COMPLETED" } as any)).toBe(true);
    expect(isOrderComplete(ORDER as any)).toBe(false);
    expect(isOrderFailed({ ...ORDER, order_state: "FAILED" } as any)).toBe(true);
    expect(orderInvoice(ORDER as any)).toBe("lnbc1...");
    expect(orderInvoice({ order_id: "x", order_state: "CREATED" } as any)).toBeUndefined();
  });
});

describe("Lsps1RestClient", () => {
  it("GETs {base}/get_info (path-per-method, no JSON-RPC envelope)", async () => {
    const { impl, calls } = fakeFetch({ "/get_info": GET_INFO });
    const client = new Lsps1RestClient({ baseUrl: "https://megalithic.me/api/lsps1/v1", fetchImpl: impl });
    const info = await client.getInfo();
    expect(info.uris).toEqual(["038a9e56@64.23.162.51:9735"]);
    expect(calls[0]).toMatchObject({ url: "https://megalithic.me/api/lsps1/v1/get_info", method: "GET" });
  });

  it("POSTs the bare order body to {base}/create_order", async () => {
    const { impl, calls } = fakeFetch({ "/create_order": ORDER });
    const client = new Lsps1RestClient({ baseUrl: "https://megalithic.me/api/lsps1/v1/", fetchImpl: impl }); // trailing slash tolerated
    const res = await client.createOrder({
      lsp_balance_sat: "1000000",
      client_balance_sat: "0",
      required_channel_confirmations: 0,
      funding_confirms_within_blocks: 6,
      channel_expiry_blocks: 13140,
      announce_channel: false,
      public_key: "02aa",
    });
    expect(res.order_id).toBe("abc-123");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://megalithic.me/api/lsps1/v1/create_order");
    // bare params object, no {jsonrpc, id, method, params}
    expect(calls[0].body).toMatchObject({ public_key: "02aa", lsp_balance_sat: "1000000" });
    expect(calls[0].body.jsonrpc).toBeUndefined();
  });

  it("GETs get_order with an order_id query param", async () => {
    const { impl, calls } = fakeFetch({ "/get_order": { ...ORDER, order_state: "COMPLETED" } });
    const client = new Lsps1RestClient({ baseUrl: "https://lsps1.lnolymp.us/api/v1", fetchImpl: impl });
    const res = await client.getOrder("abc-123");
    expect(isOrderComplete(res)).toBe(true);
    expect(calls[0].url).toBe("https://lsps1.lnolymp.us/api/v1/get_order?order_id=abc-123");
  });

  it("throws on a non-2xx response", async () => {
    const impl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const client = new Lsps1RestClient({ baseUrl: "https://x/api", fetchImpl: impl });
    await expect(client.getInfo()).rejects.toThrow();
  });

  // Regression: in a browser the global `fetch` must be invoked with `this === window`/globalThis, or
  // it throws "Failed to execute 'fetch' on 'Window': Illegal invocation". Storing the bare global and
  // calling it as `this.fetchImpl(url)` sets `this` to the client instance and triggers that error.
  // Seen live in the extension/PWA LSPS1 quote flow. The default fetch must be bound to globalThis.
  it("default fetch is invoked with globalThis as receiver (no 'Illegal invocation')", async () => {
    const realFetch = globalThis.fetch;
    const brandChecked = function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return Promise.resolve(
        new Response(JSON.stringify(GET_INFO), { status: 200, headers: { "content-type": "application/json" } })
      );
    };
    (globalThis as any).fetch = brandChecked;
    try {
      // No fetchImpl injected → the client must default to a correctly-bound global fetch.
      const client = new Lsps1RestClient({ baseUrl: "https://lsp.example/api" });
      const info = await client.getInfo();
      expect(info.min_channel_balance_sat).toBe("150000");
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });
});
