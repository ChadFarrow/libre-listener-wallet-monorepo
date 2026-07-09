import { describe, it, expect } from "vitest";
import { MockLsps1Provider, MockLspError } from "../mock-provider";
import { routeMockLsps1 } from "../http-router";
import type { Lsps1RestCreateOrderRequest } from "@libre/shared";

const orderBody = (over: Partial<Lsps1RestCreateOrderRequest> = {}): Lsps1RestCreateOrderRequest => ({
  lsp_balance_sat: "1000000",
  client_balance_sat: "0",
  required_channel_confirmations: 0,
  funding_confirms_within_blocks: 6,
  channel_expiry_blocks: 13140,
  announce_channel: false,
  public_key: "02aa",
  ...over,
});

describe("MockLsps1Provider.getInfo", () => {
  it("returns spec-shaped bounds + a dial uri (Megalith-like 0-conf defaults)", () => {
    const info = new MockLsps1Provider().getInfo();
    expect(info.min_channel_balance_sat).toBe("150000");
    expect(info.max_channel_balance_sat).toBe("16000000");
    expect(info.max_channel_expiry_blocks).toBe(13140);
    expect(info.min_required_channel_confirmations).toBe(0);
    expect(info.uris).toHaveLength(1);
    expect(info.uris[0]).toMatch(/^[0-9a-f]{66}@127\.0\.0\.1:9999$/);
  });

  it("advertises a confirmed (non-0-conf) provider when min confs > 0 (Olympus-like)", () => {
    const info = new MockLsps1Provider({ minRequiredChannelConfirmations: 3 }).getInfo();
    expect(info.min_required_channel_confirmations).toBe(3);
    expect(info.supports_zero_channel_reserve).toBe(false);
  });

  it("supports_zero_channel_reserve is its own knob (zero reserve ≠ zero conf), default off", () => {
    // A 0-conf LSP does not imply a zero channel reserve — keep the two signals independent.
    expect(new MockLsps1Provider().getInfo().supports_zero_channel_reserve).toBe(false);
    const info = new MockLsps1Provider({
      minRequiredChannelConfirmations: 0,
      supportsZeroChannelReserve: true,
    }).getInfo();
    expect(info.supports_zero_channel_reserve).toBe(true);
  });
});

describe("MockLsps1Provider.createOrder", () => {
  it("mints an order with an EXPECT_PAYMENT invoice + computed fee", () => {
    const p = new MockLsps1Provider({ feeBaseSat: 2000, feePpm: 4000 });
    const order = p.createOrder(orderBody({ lsp_balance_sat: "1000000" }));
    expect(order.order_id).toBe("mock-order-1");
    expect(order.order_state).toBe("CREATED");
    expect(order.payment?.bolt11?.state).toBe("EXPECT_PAYMENT");
    // 2000 + ceil(1_000_000 * 4000 / 1e6) = 2000 + 4000 = 6000
    expect(order.payment?.bolt11?.fee_total_sat).toBe("6000");
    expect(order.payment?.bolt11?.invoice).toMatch(/^lnbcmock6000n/);
    expect(order.channel).toBeNull();
  });

  it("rejects an amount outside the LSP bounds with a 400-class error", () => {
    const p = new MockLsps1Provider({ minChannelSat: 150000 });
    expect(() => p.createOrder(orderBody({ lsp_balance_sat: "1000" }))).toThrow(MockLspError);
    try {
      p.createOrder(orderBody({ lsp_balance_sat: "1000" }));
    } catch (e) {
      expect((e as MockLspError).status).toBe(400);
    }
  });

  it("rejects channel_expiry_blocks beyond the LSP max with a 400-class error", () => {
    const p = new MockLsps1Provider({ maxChannelExpiryBlocks: 13140 });
    try {
      p.createOrder(orderBody({ channel_expiry_blocks: 13141 }));
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MockLspError);
      expect((e as MockLspError).status).toBe(400);
      expect((e as MockLspError).message).toMatch(/channel_expiry_blocks/);
    }
  });

  it("gives each order a distinct id", () => {
    const p = new MockLsps1Provider();
    expect(p.createOrder(orderBody()).order_id).toBe("mock-order-1");
    expect(p.createOrder(orderBody()).order_id).toBe("mock-order-2");
  });
});

describe("order lifecycle — manual mode", () => {
  it("stays awaiting until markPaid, then completes with a channel", () => {
    const p = new MockLsps1Provider({ advance: "manual" });
    const id = p.createOrder(orderBody()).order_id;

    expect(p.getOrder(id).payment?.bolt11?.state).toBe("EXPECT_PAYMENT");
    expect(p.getOrder(id).order_state).toBe("CREATED");

    p.markPaid(id);
    expect(p.getOrder(id).payment?.bolt11?.state).toBe("PAID");
    expect(p.getOrder(id).order_state).toBe("CREATED");

    p.complete(id);
    const done = p.getOrder(id);
    expect(done.order_state).toBe("COMPLETED");
    expect(done.channel).toBeTruthy();
  });

  it("fail() terminalizes the order", () => {
    const p = new MockLsps1Provider();
    const id = p.createOrder(orderBody()).order_id;
    p.fail(id);
    expect(p.getOrder(id).order_state).toBe("FAILED");
  });

  it("getOrder on an unknown id throws a 404-class error", () => {
    const p = new MockLsps1Provider();
    try {
      p.getOrder("nope");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MockLspError);
      expect((e as MockLspError).status).toBe(404);
    }
  });
});

describe("order lifecycle — timed mode (deterministic via injected clock)", () => {
  it("auto-walks EXPECT_PAYMENT → PAID → COMPLETED off the clock", () => {
    let now = 1_000_000;
    const p = new MockLsps1Provider({
      advance: "timed",
      paidAfterMs: 4000,
      completedAfterMs: 8000,
      clock: () => now,
    });
    const id = p.createOrder(orderBody()).order_id;

    expect(p.getOrder(id).payment?.bolt11?.state).toBe("EXPECT_PAYMENT");
    now += 5000; // past paidAfterMs
    expect(p.getOrder(id).payment?.bolt11?.state).toBe("PAID");
    expect(p.getOrder(id).order_state).toBe("CREATED");
    now += 4000; // total 9000, past completedAfterMs
    expect(p.getOrder(id).order_state).toBe("COMPLETED");
    expect(p.getOrder(id).channel).toBeTruthy();
  });

  it("a timed COMPLETED order carries the same full channel shape as manual complete()", () => {
    let now = 1_000_000;
    const p = new MockLsps1Provider({
      advance: "timed",
      paidAfterMs: 1000,
      completedAfterMs: 2000,
      clock: () => now,
    });
    const id = p.createOrder(orderBody()).order_id;
    now += 3000; // past completedAfterMs
    const ch = p.getOrder(id).channel as { funded_at?: string; funding_outpoint?: string; expires_at?: string };
    expect(ch.funded_at).toBeTruthy();
    expect(ch.funding_outpoint).toBeTruthy();
    expect(ch.expires_at).toBeTruthy();
  });
});

describe("routeMockLsps1 (pure HTTP routing)", () => {
  const q = (s = "") => new URLSearchParams(s);

  it("routes GET /get_info", () => {
    const r = routeMockLsps1(new MockLsps1Provider(), "GET", "/get_info", q());
    expect(r.status).toBe(200);
    expect((r.body as any).min_channel_balance_sat).toBe("150000");
  });

  it("routes POST /create_order (201) then GET /get_order", () => {
    const p = new MockLsps1Provider();
    const created = routeMockLsps1(p, "POST", "/create_order", q(), orderBody());
    expect(created.status).toBe(201);
    const id = (created.body as any).order_id;

    const got = routeMockLsps1(p, "GET", "/get_order", q(`order_id=${id}`));
    expect(got.status).toBe(200);
    expect((got.body as any).order_id).toBe(id);
  });

  it("get_order without order_id is a 400", () => {
    const r = routeMockLsps1(new MockLsps1Provider(), "GET", "/get_order", q());
    expect(r.status).toBe(400);
  });

  it("maps a MockLspError (bad amount) to its status, not a throw", () => {
    const r = routeMockLsps1(new MockLsps1Provider(), "POST", "/create_order", q(), orderBody({ lsp_balance_sat: "1" }));
    expect(r.status).toBe(400);
    expect((r.body as any).error).toMatch(/outside bounds/);
  });

  it("control plane drives an order to COMPLETED", () => {
    const p = new MockLsps1Provider();
    const id = (routeMockLsps1(p, "POST", "/create_order", q(), orderBody()).body as any).order_id;
    expect(routeMockLsps1(p, "POST", "/_control/pay", q(`order_id=${id}`)).status).toBe(200);
    routeMockLsps1(p, "POST", "/_control/complete", q(`order_id=${id}`));
    expect((routeMockLsps1(p, "GET", "/get_order", q(`order_id=${id}`)).body as any).order_state).toBe("COMPLETED");
  });

  it("unknown route is a 404", () => {
    const r = routeMockLsps1(new MockLsps1Provider(), "GET", "/nope", q());
    expect(r.status).toBe(404);
  });
});
