import { describe, it, expect } from "vitest";
import type { PaymentRecord } from "@libre/shared";
import { settledReceivedIds, newSettledReceived } from "./receive-settle";

function rec(over: Partial<PaymentRecord>): PaymentRecord {
  return {
    id: "hash-a",
    direction: "received",
    status: "settled",
    amountSats: 5000,
    timestamp: 1000,
    settledAt: 1000,
    ...over,
  };
}

describe("settledReceivedIds", () => {
  it("collects only settled received records", () => {
    const ids = settledReceivedIds([
      rec({ id: "in-settled" }),
      rec({ id: "in-pending", status: "pending" }),
      rec({ id: "out-settled", direction: "sent" }),
    ]);
    expect(ids).toEqual(new Set(["in-settled"]));
  });
});

describe("newSettledReceived", () => {
  it("finds a settled received record not in the baseline", () => {
    const baseline = settledReceivedIds([rec({ id: "old" })]);
    const hit = newSettledReceived(baseline, [rec({ id: "old" }), rec({ id: "fresh", amountSats: 7777 })]);
    expect(hit?.id).toBe("fresh");
    expect(hit?.amountSats).toBe(7777);
  });

  it("returns undefined when nothing new settled", () => {
    const baseline = settledReceivedIds([rec({ id: "old" })]);
    expect(newSettledReceived(baseline, [rec({ id: "old" })])).toBeUndefined();
    expect(newSettledReceived(new Set(), [])).toBeUndefined();
  });

  it("ignores new sent and pending records", () => {
    const hit = newSettledReceived(new Set(), [
      rec({ id: "sent", direction: "sent" }),
      rec({ id: "pending-in", status: "pending" }),
      rec({ id: "failed-in", status: "failed" }),
    ]);
    expect(hit).toBeUndefined();
  });

  it("picks the most recently settled when several are new", () => {
    const hit = newSettledReceived(new Set(), [
      rec({ id: "earlier", settledAt: 1000 }),
      rec({ id: "later", settledAt: 2000 }),
    ]);
    expect(hit?.id).toBe("later");
  });

  it("falls back to timestamp when settledAt is absent", () => {
    const hit = newSettledReceived(new Set(), [
      rec({ id: "a", settledAt: undefined, timestamp: 500 }),
      rec({ id: "b", settledAt: undefined, timestamp: 900 }),
    ]);
    expect(hit?.id).toBe("b");
  });
});
