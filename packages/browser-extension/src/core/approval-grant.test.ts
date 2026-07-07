import { describe, it, expect } from "vitest";
import { resolveGrantLimitSats, resolveGrantOrigin } from "./approval-grant";

// Fix 1: the grant sites (setGrantLimit + APPROVAL_DECISION) must NOT fail open to unlimited.
// `spendingLimitSats: 0` means UNLIMITED in the PermissionStore. The old `Number(x) || 0` turned
// blank ("") and garbage ("10,000"→NaN) into 0 → a silent unlimited grant. Route both through this
// strict resolver instead: unlimited is expressible ONLY as a literal 0 (the approval dialog's
// explicit "No daily limit" checkbox), everything else must be a positive integer, and anything
// unparseable is refused (throws) rather than becoming unlimited.
describe("resolveGrantLimitSats", () => {
  it("treats a literal 0 as the explicit unlimited signal", () => {
    expect(resolveGrantLimitSats(0)).toBe(0);
    expect(resolveGrantLimitSats("0")).toBe(0);
    expect(resolveGrantLimitSats(" 0 ")).toBe(0);
  });

  it("accepts a positive integer cap", () => {
    expect(resolveGrantLimitSats(10000)).toBe(10000);
    expect(resolveGrantLimitSats("5000")).toBe(5000);
  });

  it("does NOT fail open to unlimited on blank input (must throw, not return 0)", () => {
    expect(() => resolveGrantLimitSats("")).toThrow();
    expect(() => resolveGrantLimitSats("   ")).toThrow();
    expect(() => resolveGrantLimitSats(undefined)).toThrow();
    expect(() => resolveGrantLimitSats(null)).toThrow();
  });

  it("does NOT fail open to unlimited on NaN / thousands-separator / non-numeric input", () => {
    expect(() => resolveGrantLimitSats(NaN)).toThrow();
    expect(() => resolveGrantLimitSats("10,000")).toThrow();
    expect(() => resolveGrantLimitSats("abc")).toThrow();
    expect(() => resolveGrantLimitSats("1e5")).toThrow();
  });

  it("rejects negatives and non-integers (they must not coerce to 0/unlimited either)", () => {
    expect(() => resolveGrantLimitSats("-5")).toThrow();
    expect(() => resolveGrantLimitSats("1.5")).toThrow();
  });
});

// Fix 2: an APPROVAL_DECISION grant must be applied to the origin recorded when the prompt was
// created (the authoritative pending record), NOT the origin echoed back in the decision message —
// which a forged decision could spoof. The message origin is only a fallback for the SW-was-reaped
// case where no pending record survives.
describe("resolveGrantOrigin", () => {
  it("prefers the recorded pending origin over a spoofed message origin", () => {
    expect(resolveGrantOrigin("https://real.example", "https://evil.example")).toBe("https://real.example");
  });

  it("falls back to the message origin only when no pending record exists (SW restart mid-prompt)", () => {
    expect(resolveGrantOrigin(undefined, "https://site.example")).toBe("https://site.example");
  });
});
