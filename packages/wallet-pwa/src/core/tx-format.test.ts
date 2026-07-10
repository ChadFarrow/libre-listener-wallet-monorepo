import { describe, it, expect } from "vitest";
import { formatAmount, statusColor, relativeTime, groupPaymentsByDay } from "./tx-format";
import type { PaymentRecord } from "@libre/shared";

const rec = (over: Partial<PaymentRecord>): PaymentRecord => ({
  id: "aa".repeat(32),
  direction: "sent",
  status: "settled",
  amountSats: 100,
  timestamp: 0,
  ...over,
});

describe("formatAmount", () => {
  it("signs received positive and sent negative (real minus)", () => {
    expect(formatAmount(rec({ direction: "received", amountSats: 1234 }))).toBe("+1,234 sat");
    expect(formatAmount(rec({ direction: "sent", amountSats: 1234 }))).toBe("−1,234 sat");
  });
  it("renders unknown amounts unsigned", () => {
    expect(formatAmount(rec({ amountSats: 0 }))).toBe("0 sat");
  });
});

describe("statusColor", () => {
  it("maps status to the app palette", () => {
    expect(statusColor("settled")).toBe("#22c45e");
    expect(statusColor("pending")).toBe("#e0a800");
    expect(statusColor("failed")).toBe("#c0392b");
  });
});

describe("relativeTime", () => {
  const now = 1_700_000_000_000;
  it("buckets by recency", () => {
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
  });
  it("falls back to a date after ~a week", () => {
    expect(relativeTime(now - 8 * 86_400_000, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("groupPaymentsByDay", () => {
  // now = 2023-11-14T22:13:20Z
  const now = 1_700_000_000_000;
  const today = rec({ id: "01".repeat(32), timestamp: now - 3_600_000 });
  const yesterday = rec({ id: "02".repeat(32), timestamp: now - 86_400_000 });
  const older = rec({ id: "03".repeat(32), timestamp: now - 5 * 86_400_000 });

  it("groups newest-first records under Today / Yesterday / date labels", () => {
    const groups = groupPaymentsByDay([today, yesterday, older], now);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "2023-11-09"]);
    expect(groups[0].records).toEqual([today]);
    expect(groups[1].records).toEqual([yesterday]);
    expect(groups[2].records).toEqual([older]);
  });

  it("returns no groups for an empty history", () => {
    expect(groupPaymentsByDay([], now)).toEqual([]);
  });

  it("keeps multiple records of one day in their given order", () => {
    const t2 = rec({ id: "04".repeat(32), timestamp: now - 7_200_000 });
    const groups = groupPaymentsByDay([today, t2], now);
    expect(groups).toHaveLength(1);
    expect(groups[0].records.map((r) => r.id)).toEqual([today.id, t2.id]);
  });
});
