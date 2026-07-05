import { describe, it, expect } from "vitest";
import { lsps1OrderStatus, type Lsps1RestOrderResponse } from "./index";

const order = (over: Partial<Lsps1RestOrderResponse>): Lsps1RestOrderResponse => ({
  order_id: "o1",
  order_state: "CREATED",
  ...over,
});

describe("lsps1OrderStatus", () => {
  it("awaiting_payment while the invoice is unpaid", () => {
    expect(lsps1OrderStatus(order({}))).toBe("awaiting_payment");
    expect(
      lsps1OrderStatus(order({ payment: { bolt11: { state: "EXPECT_PAYMENT" } } }))
    ).toBe("awaiting_payment");
  });
  it("paid once the invoice leaves EXPECT_PAYMENT (HOLD/PAID)", () => {
    expect(lsps1OrderStatus(order({ payment: { bolt11: { state: "HOLD" } } }))).toBe("paid");
    expect(lsps1OrderStatus(order({ payment: { bolt11: { state: "PAID" } } }))).toBe("paid");
  });
  it("completed / failed from order_state (overrides payment state)", () => {
    expect(lsps1OrderStatus(order({ order_state: "COMPLETED" }))).toBe("completed");
    expect(
      lsps1OrderStatus(order({ order_state: "FAILED", payment: { bolt11: { state: "PAID" } } }))
    ).toBe("failed");
  });
});
