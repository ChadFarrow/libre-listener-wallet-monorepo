import { describe, it, expect } from "vitest";
import { computeOpeningFeeMsat, forwardedAmountMsat, parseScidToBigint } from "../fee";

describe("computeOpeningFeeMsat", () => {
  it("floors at min_fee_msat when the proportional part is smaller", () => {
    // proportional = ceil(1_000_000 * 1000 / 1e6) = 1000; min 250000 wins
    expect(computeOpeningFeeMsat(1_000_000n, { minFeeMsat: 250_000n, proportionalPpm: 1000 })).toBe(250_000n);
  });

  it("uses the proportional part when it exceeds min_fee_msat", () => {
    // proportional = ceil(1e9 * 1000 / 1e6) = 1_000_000; exceeds min 250000
    expect(computeOpeningFeeMsat(1_000_000_000n, { minFeeMsat: 250_000n, proportionalPpm: 1000 })).toBe(1_000_000n);
  });

  it("rounds the proportional part UP (ceil)", () => {
    // 1500 * 1000 / 1e6 = 1.5 -> ceil = 2
    expect(computeOpeningFeeMsat(1500n, { minFeeMsat: 0n, proportionalPpm: 1000 })).toBe(2n);
  });

  it("returns exactly min_fee_msat when proportional ppm is zero", () => {
    expect(computeOpeningFeeMsat(20_000_000n, { minFeeMsat: 250_000n, proportionalPpm: 0 })).toBe(250_000n);
  });
});

describe("forwardedAmountMsat", () => {
  it("subtracts the fee from the payment", () => {
    expect(forwardedAmountMsat(20_000_000n, 250_000n)).toBe(19_750_000n);
  });

  it("throws when the fee equals the payment (nothing left to forward)", () => {
    expect(() => forwardedAmountMsat(1000n, 1000n)).toThrow();
  });

  it("throws when the fee exceeds the payment", () => {
    expect(() => forwardedAmountMsat(1000n, 2000n)).toThrow();
  });
});

describe("parseScidToBigint", () => {
  it("parses a decimal uint64 scid string", () => {
    expect(parseScidToBigint("123456789")).toBe(123456789n);
  });

  it("accepts the max uint64", () => {
    expect(parseScidToBigint("18446744073709551615")).toBe(18446744073709551615n);
  });

  it("rejects a value above uint64 max", () => {
    expect(() => parseScidToBigint("18446744073709551616")).toThrow();
  });

  it("rejects empty, non-numeric, negative, and fractional strings", () => {
    expect(() => parseScidToBigint("")).toThrow();
    expect(() => parseScidToBigint("abc")).toThrow();
    expect(() => parseScidToBigint("-5")).toThrow();
    expect(() => parseScidToBigint("12.5")).toThrow();
  });
});
