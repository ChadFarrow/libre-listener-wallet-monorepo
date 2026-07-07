import { describe, it, expect } from "vitest";
import { parseNwcLimit } from "./nwc-limit";

describe("parseNwcLimit", () => {
  it("accepts a positive whole number", () => {
    expect(parseNwcLimit("5000")).toEqual({ ok: true, value: 5000, unlimited: false });
  });

  it("treats an explicit 0 as unlimited (not an error)", () => {
    expect(parseNwcLimit("0")).toEqual({ ok: true, value: 0, unlimited: true });
  });

  it("rejects blank (would silently be unlimited via Number('') || 0)", () => {
    expect(parseNwcLimit("").ok).toBe(false);
    expect(parseNwcLimit("   ").ok).toBe(false);
  });

  it("rejects non-numeric garbage", () => {
    expect(parseNwcLimit("abc").ok).toBe(false);
    expect(parseNwcLimit("1,000").ok).toBe(false);
    expect(parseNwcLimit("1.5").ok).toBe(false);
  });

  it("rejects negatives", () => {
    expect(parseNwcLimit("-1").ok).toBe(false);
  });
});
