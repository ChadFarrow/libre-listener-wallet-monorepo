// Pure formatting for the transactions sheet, ported from the extension's tested
// core/tx-format.ts, plus day-grouping for the sheet's separators. DOM-free.
import type { PaymentRecord } from "@libre/shared";

// "+1,234 sat" for received, "−1,234 sat" for sent (real minus sign). Amount 0 (an
// outbound send with an unknown amount) renders without a sign.
export function formatAmount(rec: Pick<PaymentRecord, "direction" | "amountSats">): string {
  const sats = Math.round(rec.amountSats);
  const abs = Math.abs(sats).toLocaleString("en-US");
  if (sats === 0) return `${abs} sat`;
  const sign = rec.direction === "received" ? "+" : "−";
  return `${sign}${abs} sat`;
}

type PaymentStatusLike = PaymentRecord["status"];

export function statusColor(status: PaymentStatusLike): string {
  switch (status) {
    case "settled":
      return "#22c45e";
    case "pending":
      return "#e0a800";
    case "failed":
      return "#c0392b";
  }
}

export function statusLabel(status: PaymentStatusLike): string {
  return status;
}

// Compact relative time ("just now", "5m ago", "3h ago", "2d ago"), falling back to a
// date for anything older than ~a week. `now` is injected for testing.
export function relativeTime(timestampMs: number, now: number): string {
  const diff = Math.max(0, now - timestampMs);
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(timestampMs).toISOString().slice(0, 10); // YYYY-MM-DD
}

export interface DayGroup<T> {
  label: string; // "Today" | "Yesterday" | "YYYY-MM-DD"
  records: T[];
}
export type PaymentDayGroup = DayGroup<PaymentRecord>;

const DAY_MS = 86_400_000;

// Group an already-sorted (newest-first) list under day separators. UTC day boundaries
// keep the labels deterministic across machines/timezones. Generic: payments and channel
// events share the sheet, so they share the grouping.
export function groupByDay<T extends { timestamp: number }>(records: T[], now: number): DayGroup<T>[] {
  const todayDay = Math.floor(now / DAY_MS);
  const groups: DayGroup<T>[] = [];
  for (const rec of records) {
    const day = Math.floor(rec.timestamp / DAY_MS);
    const label =
      day === todayDay
        ? "Today"
        : day === todayDay - 1
          ? "Yesterday"
          : new Date(day * DAY_MS).toISOString().slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.records.push(rec);
    else groups.push({ label, records: [rec] });
  }
  return groups;
}

export const groupPaymentsByDay = groupByDay<PaymentRecord>;

// A channel lifecycle event rendered in the same sheet as payments.
export interface ChannelEventRecord {
  kind: "channel-close" | "sweep";
  timestamp: number;
  sat?: number; // sweep: recovered amount (0/undefined when unknown)
  reason?: string; // close: stable ChannelCloseReason label
}

export function channelEventLabel(rec: ChannelEventRecord): string {
  return rec.kind === "channel-close" ? "Channel closed" : "Funds recovered on-chain";
}
