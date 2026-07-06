// Pure formatting helpers for the options-page transaction-history rows. Kept
// side-effect-free so the sat sign, relative time, and status color are unit-testable
// without the DOM.
import type { PaymentRecord } from "@libre/listener-wallet";

// "+1,234 sat" for received, "−1,234 sat" for sent (real minus sign). Amount 0 (an
// outbound send with an unknown amount) renders without a sign.
export function formatAmount(rec: Pick<PaymentRecord, "direction" | "amountSats">): string {
  const sats = Math.round(rec.amountSats);
  const abs = Math.abs(sats).toLocaleString();
  if (sats === 0) return `${abs} sat`;
  const sign = rec.direction === "received" ? "+" : "−";
  return `${sign}${abs} sat`;
}

// Accent color per status, matching the channels card convention.
export function statusColor(status: PaymentStatusLike): string {
  switch (status) {
    case "settled":
      return "#22c45e"; // green
    case "pending":
      return "#e0a800"; // amber
    case "failed":
      return "#c0392b"; // red
  }
}

export function statusLabel(status: PaymentStatusLike): string {
  return status; // "settled" | "pending" | "failed"
}

type PaymentStatusLike = PaymentRecord["status"];

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
