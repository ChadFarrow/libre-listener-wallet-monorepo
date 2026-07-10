import { describe, it, expect } from "vitest";
import { presetToAllowedMethods, presetLabel, NWC_PERMISSION_PRESETS } from "./nwc-presets";

describe("presetToAllowedMethods", () => {
  it("full access keeps the permissive legacy shape (undefined)", () => {
    expect(presetToAllowedMethods("full")).toBeUndefined();
  });

  it("pay-only grants exactly the spend methods", () => {
    expect(presetToAllowedMethods("pay")).toEqual(["pay_invoice", "pay_keysend"]);
  });

  it("read-only grants no spend methods (get_info/list_transactions are never gated)", () => {
    expect(presetToAllowedMethods("readonly")).toEqual(["get_balance"]);
  });
});

describe("presetLabel", () => {
  it("labels every preset", () => {
    for (const p of NWC_PERMISSION_PRESETS) {
      expect(presetLabel(p).length).toBeGreaterThan(0);
    }
    expect(presetLabel("readonly")).toMatch(/read/i);
  });
});
