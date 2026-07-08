import { describe, it, expect } from "vitest";
import { parseStrictInt } from "./strict-int";

describe("parseStrictInt", () => {
  it("accepts plain integers, with surrounding whitespace trimmed", () => {
    expect(parseStrictInt("1000")).toBe(1000);
    expect(parseStrictInt(" 42 ")).toBe(42);
    expect(parseStrictInt("0")).toBe(0);
  });

  it("rejects blank and non-numeric input", () => {
    expect(parseStrictInt("")).toBeNull();
    expect(parseStrictInt("   ")).toBeNull();
    expect(parseStrictInt("abc")).toBeNull();
    expect(parseStrictInt("10sats")).toBeNull();
  });

  it("rejects lossy forms that parseInt/Number silently mangle", () => {
    expect(parseStrictInt("1,000")).toBeNull();
    expect(parseStrictInt("1e9")).toBeNull();
    expect(parseStrictInt("1.5")).toBeNull();
    expect(parseStrictInt("-5")).toBeNull();
    expect(parseStrictInt("0x10")).toBeNull();
  });

  it("rejects non-canonical and unsafe-precision values", () => {
    expect(parseStrictInt("007")).toBeNull();
    expect(parseStrictInt("99999999999999999999")).toBeNull();
  });
});
