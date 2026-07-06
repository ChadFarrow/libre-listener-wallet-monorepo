import { describe, it, expect } from "vitest";
import { paymentRecordsToNwcTransactions } from "./nwc-transactions";
import type { PaymentRecord } from "./payment-record";

const rec = (over: Partial<PaymentRecord>): PaymentRecord => ({
  id: "hash",
  direction: "sent",
  status: "settled",
  amountSats: 1000,
  timestamp: 1_700_000_000_000, // ms
  ...over,
});

describe("paymentRecordsToNwcTransactions", () => {
  it("maps direction to NIP-47 type", () => {
    const out = paymentRecordsToNwcTransactions([
      rec({ id: "a", direction: "sent" }),
      rec({ id: "b", direction: "received" }),
    ]);
    expect(out.find((t) => t.payment_hash === "a")!.type).toBe("outgoing");
    expect(out.find((t) => t.payment_hash === "b")!.type).toBe("incoming");
  });

  it("converts sats→msat and ms→unix-seconds", () => {
    const [tx] = paymentRecordsToNwcTransactions([
      rec({ amountSats: 2500, feeSats: 3, timestamp: 1_700_000_000_000, settledAt: 1_700_000_005_000 }),
    ]);
    expect(tx.amount).toBe(2_500_000);
    expect(tx.fees_paid).toBe(3_000);
    expect(tx.created_at).toBe(1_700_000_000);
    expect(tx.settled_at).toBe(1_700_000_005);
  });

  it("omits settled_at until settled", () => {
    const [pending] = paymentRecordsToNwcTransactions([rec({ status: "pending", settledAt: undefined })]);
    expect(pending.settled_at).toBeUndefined();
    const [failed] = paymentRecordsToNwcTransactions([rec({ status: "failed" })]);
    expect(failed.settled_at).toBeUndefined();
  });

  it("falls back to created_at when a settled record has no settledAt", () => {
    const [tx] = paymentRecordsToNwcTransactions([rec({ status: "settled", settledAt: undefined, timestamp: 1_700_000_000_000 })]);
    expect(tx.settled_at).toBe(1_700_000_000);
  });

  it("carries note→description and preimage when present", () => {
    const [tx] = paymentRecordsToNwcTransactions([rec({ note: "Podcast · Ep 1", preimage: "deadbeef" })]);
    expect(tx.description).toBe("Podcast · Ep 1");
    expect(tx.preimage).toBe("deadbeef");
  });

  it("filters by type", () => {
    const out = paymentRecordsToNwcTransactions(
      [rec({ id: "a", direction: "sent" }), rec({ id: "b", direction: "received" })],
      { type: "incoming" }
    );
    expect(out.map((t) => t.payment_hash)).toEqual(["b"]);
  });

  it("filters by from/until (unix seconds against created_at)", () => {
    const recs = [
      rec({ id: "old", timestamp: 1_000_000_000_000 }),
      rec({ id: "mid", timestamp: 1_700_000_000_000 }),
      rec({ id: "new", timestamp: 2_000_000_000_000 }),
    ];
    const out = paymentRecordsToNwcTransactions(recs, { from: 1_500_000_000, until: 1_800_000_000 });
    expect(out.map((t) => t.payment_hash)).toEqual(["mid"]);
  });

  it("returns newest first and paginates with offset/limit", () => {
    const recs = [
      rec({ id: "t1", timestamp: 1000 }),
      rec({ id: "t2", timestamp: 2000 }),
      rec({ id: "t3", timestamp: 3000 }),
    ];
    expect(paymentRecordsToNwcTransactions(recs).map((t) => t.payment_hash)).toEqual(["t3", "t2", "t1"]);
    expect(paymentRecordsToNwcTransactions(recs, { limit: 1 }).map((t) => t.payment_hash)).toEqual(["t3"]);
    expect(paymentRecordsToNwcTransactions(recs, { offset: 1, limit: 1 }).map((t) => t.payment_hash)).toEqual(["t2"]);
  });
});
