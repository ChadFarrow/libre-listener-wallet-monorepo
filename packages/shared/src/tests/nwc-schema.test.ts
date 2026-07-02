import { describe, it, expect } from "vitest";
import {
  makeInvoiceParamsSchema,
  payKeysendParamsSchema,
  payInvoiceParamsSchema,
  nwcRequestSchema,
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

  it("accepts optional tlv_records", () => {
    const parsed = payKeysendParamsSchema.parse({
      amount: 100,
      pubkey: validPubkey,
      tlv_records: [{ type: 7629169, value: "deadbeef" }],
    });
    expect(parsed.tlv_records).toHaveLength(1);
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
