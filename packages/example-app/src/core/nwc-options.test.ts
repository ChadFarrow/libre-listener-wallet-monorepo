import { describe, it, expect } from "vitest";
import {
  parseBudgetRenewal,
  parseMaxAmount,
  buildAllowedMethods,
  expiryFromDays,
  renewalLabel,
} from "./nwc-options";
import type { NwcMethod } from "@libre/shared";

describe("parseBudgetRenewal", () => {
  it("accepts each valid renewal", () => {
    for (const r of ["never", "daily", "weekly", "monthly", "yearly"] as const) {
      expect(parseBudgetRenewal(r)).toBe(r);
    }
  });
  it("falls back to daily for an unknown value", () => {
    expect(parseBudgetRenewal("fortnightly")).toBe("daily");
    expect(parseBudgetRenewal("")).toBe("daily");
  });
});

describe("parseMaxAmount", () => {
  it("treats blank as no cap", () => {
    expect(parseMaxAmount("")).toEqual({ ok: true, value: undefined });
    expect(parseMaxAmount("   ")).toEqual({ ok: true, value: undefined });
  });
  it("parses a positive integer", () => {
    expect(parseMaxAmount("1000")).toEqual({ ok: true, value: 1000 });
  });
  it("rejects a non-integer or zero rather than silently allowing unlimited", () => {
    expect(parseMaxAmount("abc").ok).toBe(false);
    expect(parseMaxAmount("10.5").ok).toBe(false);
    expect(parseMaxAmount("0").ok).toBe(false);
    expect(parseMaxAmount("-5").ok).toBe(false);
  });
});

describe("buildAllowedMethods", () => {
  const allChecked: Record<NwcMethod, boolean> = {
    get_balance: true,
    make_invoice: true,
    pay_invoice: true,
    pay_keysend: true,
  };

  it("returns undefined (all methods) when everything is checked", () => {
    expect(buildAllowedMethods(allChecked)).toBeUndefined();
  });

  it("returns the exact subset when some are unchecked", () => {
    const readOnly: Record<NwcMethod, boolean> = {
      get_balance: true,
      make_invoice: true,
      pay_invoice: false,
      pay_keysend: false,
    };
    expect(buildAllowedMethods(readOnly)).toEqual(["get_balance", "make_invoice"]);
  });

  it("returns an empty set when nothing is checked", () => {
    const none: Record<NwcMethod, boolean> = {
      get_balance: false,
      make_invoice: false,
      pay_invoice: false,
      pay_keysend: false,
    };
    expect(buildAllowedMethods(none)).toEqual([]);
  });
});

describe("expiryFromDays", () => {
  const now = 1_700_000_000_000;
  it("returns undefined for never (0 or negative)", () => {
    expect(expiryFromDays(0, now)).toBeUndefined();
    expect(expiryFromDays(-1, now)).toBeUndefined();
  });
  it("adds the duration to now", () => {
    expect(expiryFromDays(7, now)).toBe(now + 7 * 24 * 60 * 60 * 1000);
  });
});

describe("renewalLabel", () => {
  it("labels each renewal, defaulting undefined to daily", () => {
    expect(renewalLabel(undefined)).toBe("daily");
    expect(renewalLabel("never")).toBe("one-time");
    expect(renewalLabel("monthly")).toBe("monthly");
  });
});
