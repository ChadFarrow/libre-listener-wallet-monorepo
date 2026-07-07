import { describe, it, expect } from "vitest";
import {
  makeInvoiceParamsSchema,
  payKeysendParamsSchema,
  payInvoiceParamsSchema,
  listTransactionsParamsSchema,
  nwcRequestSchema,
  budgetWindowElapsed,
} from "../nwc-schema";

const validPubkey = "02" + "a".repeat(64); // 33-byte compressed key => 66 hex chars
const validPreimage = "b".repeat(64);

describe("makeInvoiceParamsSchema", () => {
  it("accepts a numeric amount", () => {
    const parsed = makeInvoiceParamsSchema.parse({ amount: 1000 });
    expect(parsed.amount).toBe(1000);
  });

  it("coerces a string amount and expiry to numbers", () => {
    const parsed = makeInvoiceParamsSchema.parse({ amount: "1500", expiry: "3600" });
    expect(parsed.amount).toBe(1500);
    expect(parsed.expiry).toBe(3600);
  });

  it("rejects a missing amount", () => {
    expect(() => makeInvoiceParamsSchema.parse({ description: "x" })).toThrow();
  });

  it("rejects non-positive, non-integer, and lossy amounts", () => {
    expect(() => makeInvoiceParamsSchema.parse({ amount: 0 })).toThrow();
    expect(() => makeInvoiceParamsSchema.parse({ amount: -100 })).toThrow();
    expect(() => makeInvoiceParamsSchema.parse({ amount: 1.5 })).toThrow();
    expect(() => makeInvoiceParamsSchema.parse({ amount: "-5000" })).toThrow();
    expect(() => makeInvoiceParamsSchema.parse({ amount: "junk" })).toThrow();
    expect(() => makeInvoiceParamsSchema.parse({ amount: "" })).toThrow();
    // "1e9"/"1,000" must NOT silently parseInt to 1 / 1 — reject them.
    expect(() => makeInvoiceParamsSchema.parse({ amount: "1e9" })).toThrow();
    expect(() => makeInvoiceParamsSchema.parse({ amount: "1,000" })).toThrow();
  });

  it("rejects a negative expiry but allows 0", () => {
    expect(makeInvoiceParamsSchema.parse({ amount: 100, expiry: 0 }).expiry).toBe(0);
    expect(() => makeInvoiceParamsSchema.parse({ amount: 100, expiry: -1 })).toThrow();
  });
});

describe("payInvoiceParamsSchema", () => {
  it("requires an invoice string", () => {
    expect(payInvoiceParamsSchema.parse({ invoice: "lnbc1..." }).invoice).toBe("lnbc1...");
    expect(() => payInvoiceParamsSchema.parse({})).toThrow();
  });
});

describe("payKeysendParamsSchema", () => {
  it("accepts a 66-hex compressed pubkey", () => {
    const parsed = payKeysendParamsSchema.parse({ amount: 100, pubkey: validPubkey });
    expect(parsed.pubkey).toBe(validPubkey);
  });

  it("rejects a 64-hex Nostr key (regression: keysends were wrongly rejected/accepted)", () => {
    // A 32-byte Nostr key (64 hex, no 02/03 prefix) must NOT validate as a node pubkey.
    expect(() =>
      payKeysendParamsSchema.parse({ amount: 100, pubkey: "a".repeat(64) }),
    ).toThrow();
  });

  it("rejects a pubkey without the 02/03 compression prefix", () => {
    expect(() =>
      payKeysendParamsSchema.parse({ amount: 100, pubkey: "04" + "a".repeat(64) }),
    ).toThrow();
  });

  it("accepts an optional 64-hex preimage and rejects a malformed one", () => {
    expect(
      payKeysendParamsSchema.parse({ amount: 100, pubkey: validPubkey, preimage: validPreimage })
        .preimage,
    ).toBe(validPreimage);
    expect(() =>
      payKeysendParamsSchema.parse({ amount: 100, pubkey: validPubkey, preimage: "xyz" }),
    ).toThrow();
  });

  it("coerces a string amount to a number", () => {
    expect(
      payKeysendParamsSchema.parse({ amount: "250", pubkey: validPubkey }).amount,
    ).toBe(250);
  });

  it("rejects a negative/zero/NaN amount (spend-cap checks must never see a nonsense amount)", () => {
    expect(() =>
      payKeysendParamsSchema.parse({ amount: -5000, pubkey: validPubkey }),
    ).toThrow();
    expect(() =>
      payKeysendParamsSchema.parse({ amount: "-5000", pubkey: validPubkey }),
    ).toThrow();
    expect(() =>
      payKeysendParamsSchema.parse({ amount: 0, pubkey: validPubkey }),
    ).toThrow();
    expect(() =>
      payKeysendParamsSchema.parse({ amount: "junk", pubkey: validPubkey }),
    ).toThrow();
  });

  it("accepts optional tlv_records", () => {
    const parsed = payKeysendParamsSchema.parse({
      amount: 100,
      pubkey: validPubkey,
      tlv_records: [{ type: 7629169, value: "deadbeef" }],
    });
    expect(parsed.tlv_records).toHaveLength(1);
  });
});

describe("listTransactionsParamsSchema", () => {
  it("accepts all-optional numeric bounds (number or digit string)", () => {
    const parsed = listTransactionsParamsSchema.parse({ from: "1700000000", until: 1800000000, limit: "10", offset: 0 });
    expect(parsed).toEqual({ from: 1700000000, until: 1800000000, limit: 10, offset: 0 });
    expect(listTransactionsParamsSchema.parse(undefined)).toBeUndefined();
    expect(listTransactionsParamsSchema.parse({})).toEqual({});
  });

  it("rejects garbage bounds instead of silently blanking history", () => {
    expect(() => listTransactionsParamsSchema.parse({ from: "yesterday" })).toThrow();
    expect(() => listTransactionsParamsSchema.parse({ until: "NaN" })).toThrow();
    expect(() => listTransactionsParamsSchema.parse({ limit: -1 })).toThrow();
  });
});

describe("nwcRequestSchema (discriminated union)", () => {
  it("accepts get_info / get_balance with no params", () => {
    expect(nwcRequestSchema.parse({ method: "get_info" }).method).toBe("get_info");
    expect(nwcRequestSchema.parse({ method: "get_balance" }).method).toBe("get_balance");
  });

  it("validates make_invoice params against the invoice schema", () => {
    const parsed = nwcRequestSchema.parse({ method: "make_invoice", params: { amount: "1000" } });
    expect(parsed.method).toBe("make_invoice");
    if (parsed.method === "make_invoice") {
      expect(parsed.params.amount).toBe(1000);
    }
  });

  it("validates pay_keysend params, rejecting a bad pubkey", () => {
    expect(() =>
      nwcRequestSchema.parse({ method: "pay_keysend", params: { amount: 100, pubkey: "nope" } }),
    ).toThrow();
    expect(
      nwcRequestSchema.parse({ method: "pay_keysend", params: { amount: 100, pubkey: validPubkey } })
        .method,
    ).toBe("pay_keysend");
  });

  it("rejects an unknown method", () => {
    expect(() => nwcRequestSchema.parse({ method: "self_destruct", params: {} })).toThrow();
  });
});

describe("budgetWindowElapsed", () => {
  const start = 1_700_000_000_000;
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;

  it("defaults to a rolling 24h window when renewal is undefined (legacy behavior)", () => {
    expect(budgetWindowElapsed(undefined, start, start + 23 * hour)).toBe(false);
    expect(budgetWindowElapsed(undefined, start, start + 25 * hour)).toBe(true);
  });

  it("daily resets after 24h", () => {
    expect(budgetWindowElapsed("daily", start, start + 23 * hour)).toBe(false);
    expect(budgetWindowElapsed("daily", start, start + day)).toBe(true);
  });

  it("weekly resets after 7 days", () => {
    expect(budgetWindowElapsed("weekly", start, start + 6 * day)).toBe(false);
    expect(budgetWindowElapsed("weekly", start, start + 7 * day)).toBe(true);
  });

  it("monthly resets after ~30 days", () => {
    expect(budgetWindowElapsed("monthly", start, start + 29 * day)).toBe(false);
    expect(budgetWindowElapsed("monthly", start, start + 30 * day)).toBe(true);
  });

  it("yearly resets after ~365 days", () => {
    expect(budgetWindowElapsed("yearly", start, start + 364 * day)).toBe(false);
    expect(budgetWindowElapsed("yearly", start, start + 365 * day)).toBe(true);
  });

  it("never resets, no matter how much time passes", () => {
    expect(budgetWindowElapsed("never", start, start + 10 * 365 * day)).toBe(false);
  });
});
