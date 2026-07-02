import { describe, it, expect } from "vitest";
import { SETTLEMENT_PENDING_MARKER, isSettlementPending, settlementPendingMessage } from "./settlement-pending";

describe("isSettlementPending", () => {
  it("is true for the settlement-timeout message (payment still in flight → keep the charge)", () => {
    expect(isSettlementPending(settlementPendingMessage())).toBe(true);
    expect(isSettlementPending(`Error: ${SETTLEMENT_PENDING_MARKER} extra context`)).toBe(true);
  });

  it("is false for pre-initiation failures (payment never left → refund the cap)", () => {
    expect(isSettlementPending("send_payment failed: route not found")).toBe(false);
    expect(isSettlementPending("Invalid BOLT11 invoice")).toBe(false);
    expect(isSettlementPending("Zero-amount invoices are not supported")).toBe(false);
    expect(isSettlementPending("LDK payment execution failed")).toBe(false);
  });

  it("is false for missing/empty messages", () => {
    expect(isSettlementPending(undefined)).toBe(false);
    expect(isSettlementPending("")).toBe(false);
  });
});
