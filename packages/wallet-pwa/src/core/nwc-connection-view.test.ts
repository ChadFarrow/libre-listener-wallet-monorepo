import { describe, it, expect } from "vitest";
import { sanitizeConnection, limitLabel, expiryLabel } from "./nwc-connection-view";

const FULL = {
  name: "stablekraft",
  clientPubkey: "ab".repeat(32),
  secret: "SUPER-SECRET-KEY",
  spendingLimitSats: 10_000,
  spentTodaySats: 2_350,
  lastSpentTimestamp: 1_700_000_000_000,
  createdAt: 1_699_999_999_000,
  enabled: true,
  relayUrl: "wss://relay.getalby.com/v1",
  budgetRenewal: "daily" as const,
  maxAmountSats: 5_000,
  allowedMethods: ["pay_invoice" as const],
  expiresAt: undefined,
};

describe("sanitizeConnection", () => {
  it("never exposes the pairing secret", () => {
    const v = sanitizeConnection(FULL);
    expect("secret" in v).toBe(false);
    expect(JSON.stringify(v)).not.toContain("SUPER-SECRET");
  });

  it("carries the detail-screen fields through", () => {
    const v = sanitizeConnection(FULL);
    expect(v.name).toBe("stablekraft");
    expect(v.clientPubkey).toBe("ab".repeat(32));
    expect(v.spendingLimitSats).toBe(10_000);
    expect(v.spentThisPeriodSats).toBe(2_350);
    expect(v.budgetRenewal).toBe("daily");
    expect(v.maxAmountSats).toBe(5_000);
    expect(v.allowedMethods).toEqual(["pay_invoice"]);
    expect(v.createdAt).toBe(1_699_999_999_000);
    expect(v.expiresAt).toBeUndefined();
  });

  it("defaults missing optional numbers instead of dropping them", () => {
    const v = sanitizeConnection({ ...FULL, spendingLimitSats: undefined as unknown as number, spentTodaySats: undefined as unknown as number });
    expect(v.spendingLimitSats).toBe(0);
    expect(v.spentThisPeriodSats).toBe(0);
  });
});

describe("limitLabel", () => {
  it("labels an unlimited budget", () => {
    expect(limitLabel(0, "daily")).toBe("Unlimited");
  });
  it("labels a renewing budget with its period", () => {
    expect(limitLabel(10_000, "daily")).toBe("10,000 sats / day");
    expect(limitLabel(10_000, "weekly")).toBe("10,000 sats / week");
    expect(limitLabel(10_000, "monthly")).toBe("10,000 sats / month");
    expect(limitLabel(10_000, "yearly")).toBe("10,000 sats / year");
  });
  it("treats undefined renewal as the legacy daily window", () => {
    expect(limitLabel(500, undefined)).toBe("500 sats / day");
  });
  it("labels a never-renewing budget as a total", () => {
    expect(limitLabel(10_000, "never")).toBe("10,000 sats total");
  });
});

describe("expiryLabel", () => {
  const now = 1_700_000_000_000;
  it("labels no expiry as Never", () => {
    expect(expiryLabel(undefined, now)).toBe("Never");
  });
  it("labels a past expiry as Expired", () => {
    expect(expiryLabel(now - 1000, now)).toBe("Expired");
  });
  it("renders a future expiry as a date", () => {
    expect(expiryLabel(now + 86_400_000 * 30, now)).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
