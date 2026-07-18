import { describe, it, expect } from "vitest";
import type { PaymentRecord } from "@libre/shared";
import { toTxView, toTxViews, makeTransactionFeed } from "./transactions";

const rec = (over: Partial<PaymentRecord> = {}): PaymentRecord => ({
  id: "hash1",
  direction: "received",
  status: "settled",
  amountSats: 100,
  timestamp: 1000,
  ...over,
});

describe("toTxView", () => {
  it("maps every display field and OMITS the preimage (a feed needs no receipts)", () => {
    const v = toTxView(
      rec({
        preimage: "deadbeef",
        feeSats: 2,
        settledAt: 1500,
        counterparty: "02ab",
        type: "keysend",
        note: "Podcast · Ep 1",
      }),
    );
    expect(v).toEqual({
      id: "hash1",
      direction: "received",
      status: "settled",
      amountSats: 100,
      feeSats: 2,
      timestamp: 1000,
      settledAt: 1500,
      counterparty: "02ab",
      type: "keysend",
      note: "Podcast · Ep 1",
    });
    expect("preimage" in v).toBe(false);
  });
});

describe("toTxViews", () => {
  it("returns the log newest-first regardless of input order", () => {
    const out = toTxViews([
      rec({ id: "a", timestamp: 100 }),
      rec({ id: "b", timestamp: 300 }),
      rec({ id: "c", timestamp: 200 }),
    ]);
    expect(out.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });
});

describe("makeTransactionFeed", () => {
  it("baselines existing settled history without emitting, then emits only newly-settled records", () => {
    const feed = makeTransactionFeed();
    // First ingest is the baseline: whatever history already exists is NOT "new".
    expect(feed.ingest([rec({ id: "old", status: "settled" })])).toEqual([]);
    // A record that settles after the baseline is emitted exactly once.
    const fresh = feed.ingest([
      rec({ id: "old", status: "settled" }),
      rec({ id: "new", status: "settled", amountSats: 50 }),
    ]);
    expect(fresh.map((t) => t.id)).toEqual(["new"]);
    // The same set again yields nothing new.
    expect(feed.ingest([rec({ id: "old", status: "settled" }), rec({ id: "new", status: "settled" })])).toEqual([]);
  });

  it("emits on settlement only — never for pending or failed records", () => {
    const feed = makeTransactionFeed();
    feed.ingest([]); // baseline empty
    expect(feed.ingest([rec({ id: "p", status: "pending" })])).toEqual([]);
    expect(feed.ingest([rec({ id: "f", status: "failed" })])).toEqual([]);
    // The pending record now settles → emitted.
    expect(feed.ingest([rec({ id: "p", status: "settled" })]).map((t) => t.id)).toEqual(["p"]);
  });
});
