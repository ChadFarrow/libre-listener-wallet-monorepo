import { describe, it, expect } from "vitest";
import { LSPS1_REST_PROVIDERS } from "@libre/shared";
import {
  formatOpeningFee,
  validateAmountForProvider,
  suggestProviderForAmount,
  providerSummary,
  isLeaseOptionAvailable,
  clampLeaseSelectionValue,
} from "./lsps1-provider-ui";

const megalith = LSPS1_REST_PROVIDERS.megalith;
const olympus = LSPS1_REST_PROVIDERS.olympus;

describe("formatOpeningFee", () => {
  it("shows absolute sat + percentage of the channel size", () => {
    expect(formatOpeningFee(18507, 1_000_000)).toBe("18,507 sat (1.85% of 1,000,000 sat)");
  });
  it("accepts a string fee (LSPS1 REST returns sat amounts as strings)", () => {
    expect(formatOpeningFee("18507", 1_000_000)).toBe("18,507 sat (1.85% of 1,000,000 sat)");
  });
  it("handles a missing/unknown fee", () => {
    expect(formatOpeningFee(undefined, 1_000_000)).toBe("fee unknown");
    expect(formatOpeningFee(NaN, 1_000_000)).toBe("fee unknown");
    expect(formatOpeningFee("", 1_000_000)).toBe("fee unknown");
    expect(formatOpeningFee("abc", 1_000_000)).toBe("fee unknown");
  });
  it("does not divide by zero", () => {
    expect(formatOpeningFee(1000, 0)).toContain("1,000 sat");
  });
});

describe("validateAmountForProvider", () => {
  it("accepts an in-range amount", () => {
    expect(validateAmountForProvider(1_000_000, megalith).ok).toBe(true);
    expect(validateAmountForProvider(100_000, olympus).ok).toBe(true);
  });
  it("rejects below the provider minimum with a helpful message (today's Megalith 150k finding)", () => {
    const r = validateAmountForProvider(100_000, megalith);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("150,000");
    expect(r.message).toContain(megalith.name);
  });
  it("rejects above the provider maximum", () => {
    const r = validateAmountForProvider(20_000_000, olympus);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("10,000,000");
  });
  it("rejects a non-positive / non-finite amount", () => {
    expect(validateAmountForProvider(0, megalith).ok).toBe(false);
    expect(validateAmountForProvider(NaN, megalith).ok).toBe(false);
  });
});

describe("suggestProviderForAmount", () => {
  it("suggests Olympus when a sub-150k amount is out of Megalith's range", () => {
    const s = suggestProviderForAmount(100_000, "megalith");
    expect(s?.key).toBe("olympus");
  });
  it("returns undefined when no other provider can serve the amount", () => {
    // 20M is above both providers' max — nobody else fits either.
    expect(suggestProviderForAmount(20_000_000, "megalith")).toBeUndefined();
  });
  it("never suggests the excluded provider itself", () => {
    const s = suggestProviderForAmount(500_000, "megalith");
    expect(s?.key).not.toBe("megalith");
  });
});

describe("isLeaseOptionAvailable", () => {
  it("'Longest available' (empty/0 blocks) is always available", () => {
    expect(isLeaseOptionAvailable(0, megalith.maxLeaseBlocks)).toBe(true);
  });
  it("hides a lease longer than the provider's max (Megalith ~3mo can't do 6/12mo)", () => {
    expect(isLeaseOptionAvailable(25_920, megalith.maxLeaseBlocks)).toBe(false); // ~6mo
    expect(isLeaseOptionAvailable(52_560, megalith.maxLeaseBlocks)).toBe(false); // ~12mo
  });
  it("keeps a lease within the provider's max (Megalith allows ~1mo and ~3mo)", () => {
    expect(isLeaseOptionAvailable(4_320, megalith.maxLeaseBlocks)).toBe(true); // ~1mo
    expect(isLeaseOptionAvailable(12_960, megalith.maxLeaseBlocks)).toBe(true); // ~3mo < 13,140
  });
  it("Olympus (~12mo) allows every option", () => {
    for (const b of [4_320, 12_960, 25_920, 52_560]) {
      expect(isLeaseOptionAvailable(b, olympus.maxLeaseBlocks)).toBe(true);
    }
  });
});

describe("clampLeaseSelectionValue", () => {
  it("resets a too-long selection to 'Longest available' ('')", () => {
    expect(clampLeaseSelectionValue("52560", megalith.maxLeaseBlocks)).toBe("");
  });
  it("keeps a valid selection unchanged", () => {
    expect(clampLeaseSelectionValue("12960", megalith.maxLeaseBlocks)).toBe("12960");
  });
  it("leaves 'Longest available' ('') as-is", () => {
    expect(clampLeaseSelectionValue("", megalith.maxLeaseBlocks)).toBe("");
  });
});

describe("providerSummary", () => {
  it("combines the cost note and the sat bounds", () => {
    const s = providerSummary(megalith);
    expect(s).toContain(megalith.costNote);
    expect(s).toContain("150,000");
    expect(s).toContain("16,000,000");
  });
});
