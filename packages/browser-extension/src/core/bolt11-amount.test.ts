import { describe, it, expect } from "vitest";
import { invoiceAmountSats } from "./bolt11-amount";

describe("invoiceAmountSats", () => {
  it("decodes common multipliers to sats", () => {
    // 1u BTC = 100 sat ; 2500u = 250,000 sat
    expect(invoiceAmountSats("lnbc2500u1p...")).toBe(250_000);
    // 1m BTC = 100,000 sat
    expect(invoiceAmountSats("lnbc1m1p...")).toBe(100_000);
    // 20n BTC = 2 sat
    expect(invoiceAmountSats("lnbc20n1p...")).toBe(2);
    // 1500n = 150 sat
    expect(invoiceAmountSats("lnbc1500n1p...")).toBe(150);
  });

  it("decodes pico amounts (rounding sub-sat)", () => {
    // 10000p BTC = 1 sat (10000 * 0.1 msat = 1000 msat = 1 sat)
    expect(invoiceAmountSats("lnbc10000p1p...")).toBe(1);
  });

  it("handles a full BTC amount with no multiplier", () => {
    // lnbc1 (1 BTC) = 100,000,000 sat
    expect(invoiceAmountSats("lnbc1" + "1" + "qqq")).toBe(100_000_000);
  });

  it("returns null for a zero-amount invoice", () => {
    expect(invoiceAmountSats("lnbc1p...")).toBeNull();
  });

  it("recognizes testnet / signet / regtest prefixes", () => {
    expect(invoiceAmountSats("lntb2500u1p...")).toBe(250_000);
    expect(invoiceAmountSats("lntbs2500u1p...")).toBe(250_000);
    expect(invoiceAmountSats("lnbcrt1m1p...")).toBe(100_000);
  });

  it("throws on a non-BOLT11 string", () => {
    expect(() => invoiceAmountSats("not-an-invoice")).toThrow();
  });
});
