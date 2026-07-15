import { describe, it, expect } from "vitest";
import { parseCapInput } from "./cap-input";

describe("parseCapInput", () => {
  it("accepts a positive integer number of sats", () => {
    expect(parseCapInput("10000")).toEqual({ ok: true, sats: 10000 });
    expect(parseCapInput("  1 ")).toEqual({ ok: true, sats: 1 });
  });

  it("rejects empty / blank input (must not silently become 0 = unlimited)", () => {
    expect(parseCapInput("")).toEqual({ ok: false });
    expect(parseCapInput("   ")).toEqual({ ok: false });
  });

  it("rejects non-numeric input (Number('10,000') === NaN must not fall through to unlimited)", () => {
    expect(parseCapInput("10,000")).toEqual({ ok: false });
    expect(parseCapInput("abc")).toEqual({ ok: false });
    expect(parseCapInput("1e5")).toEqual({ ok: false });
  });

  it("rejects zero, negatives, and non-integers", () => {
    expect(parseCapInput("0")).toEqual({ ok: false });
    expect(parseCapInput("-5")).toEqual({ ok: false });
    expect(parseCapInput("1.5")).toEqual({ ok: false });
  });
});
