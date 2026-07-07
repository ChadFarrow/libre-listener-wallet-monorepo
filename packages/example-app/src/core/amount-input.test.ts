import { describe, it, expect } from "vitest";
import { parsePositiveIntSats } from "./amount-input";

describe("parsePositiveIntSats", () => {
  it("accepts a plain positive integer", () => {
    expect(parsePositiveIntSats("1000")).toEqual({ ok: true, value: 1000 });
    expect(parsePositiveIntSats(" 42 ")).toEqual({ ok: true, value: 42 });
  });

  it("rejects a thousands-separated value (would silently send 1 sat)", () => {
    expect(parsePositiveIntSats("1,000").ok).toBe(false);
  });

  it("rejects blank / whitespace", () => {
    expect(parsePositiveIntSats("").ok).toBe(false);
    expect(parsePositiveIntSats("   ").ok).toBe(false);
  });

  it("rejects non-numeric garbage", () => {
    expect(parsePositiveIntSats("abc").ok).toBe(false);
    expect(parsePositiveIntSats("10sats").ok).toBe(false);
  });

  it("rejects zero and negatives", () => {
    expect(parsePositiveIntSats("0").ok).toBe(false);
    expect(parsePositiveIntSats("-5").ok).toBe(false);
  });

  it("rejects decimals", () => {
    expect(parsePositiveIntSats("1.5").ok).toBe(false);
    expect(parsePositiveIntSats("10.0").ok).toBe(false);
  });

  it("rejects values that do not round-trip (leading zeros, hex)", () => {
    expect(parsePositiveIntSats("007").ok).toBe(false);
    expect(parsePositiveIntSats("0x10").ok).toBe(false);
  });
});
