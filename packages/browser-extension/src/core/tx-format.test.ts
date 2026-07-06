import { describe, it, expect } from "vitest";
import { formatAmount, statusColor, statusLabel, relativeTime } from "./tx-format";

describe("formatAmount", () => {
  it("prefixes received with + and sent with a minus sign", () => {
    expect(formatAmount({ direction: "received", amountSats: 1234 })).toBe("+1,234 sat");
    expect(formatAmount({ direction: "sent", amountSats: 1234 })).toBe("−1,234 sat");
  });
  it("renders a 0 (unknown) amount without a sign", () => {
    expect(formatAmount({ direction: "sent", amountSats: 0 })).toBe("0 sat");
  });
});

describe("statusColor / statusLabel", () => {
  it("maps each status to a color", () => {
    expect(statusColor("settled")).toBe("#22c45e");
    expect(statusColor("pending")).toBe("#e0a800");
    expect(statusColor("failed")).toBe("#c0392b");
  });
  it("labels are the status string", () => {
    expect(statusLabel("settled")).toBe("settled");
  });
});

describe("relativeTime", () => {
  const now = 1_700_000_000_000;
  it("buckets recent times", () => {
    expect(relativeTime(now, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
  });
  it("falls back to a date beyond a week", () => {
    expect(relativeTime(now - 30 * 86_400_000, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("never shows negative time for a future stamp", () => {
    expect(relativeTime(now + 10_000, now)).toBe("just now");
  });
});
