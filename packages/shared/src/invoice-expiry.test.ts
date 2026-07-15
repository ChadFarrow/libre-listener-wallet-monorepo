import { describe, it, expect } from "vitest";
import { DEFAULT_INVOICE_EXPIRY_SECONDS, resolveInvoiceExpiry } from "./invoice-expiry";

describe("DEFAULT_INVOICE_EXPIRY_SECONDS", () => {
  it("is 4 hours — long enough to absorb block-time lag (a no-std LDK node stamps invoices with the last block's time, which can trail wall-time by tens of minutes, so a 1h expiry can look expired on arrival)", () => {
    expect(DEFAULT_INVOICE_EXPIRY_SECONDS).toBe(4 * 60 * 60);
    expect(DEFAULT_INVOICE_EXPIRY_SECONDS).toBe(14400);
  });
});

describe("resolveInvoiceExpiry", () => {
  it("defaults to 4 hours when unspecified", () => {
    expect(resolveInvoiceExpiry(undefined)).toBe(14400);
  });

  it("treats 0 / negative / non-finite as unspecified → default", () => {
    expect(resolveInvoiceExpiry(0)).toBe(14400);
    expect(resolveInvoiceExpiry(-30)).toBe(14400);
    expect(resolveInvoiceExpiry(NaN)).toBe(14400);
    expect(resolveInvoiceExpiry(Infinity)).toBe(14400);
  });

  it("honours an explicit positive request (e.g. an NWC client asking for a short expiry)", () => {
    expect(resolveInvoiceExpiry(600)).toBe(600);
    expect(resolveInvoiceExpiry(3600)).toBe(3600);
  });

  it("coerces a fractional request to whole seconds", () => {
    expect(resolveInvoiceExpiry(600.9)).toBe(600);
  });
});
