import type { PaymentRecord } from "@libre/shared";

// Detects "the invoice on screen got paid" for the Receive screen: snapshot the settled
// received record ids when the screen opens, then any settled received record NOT in that
// baseline means sats landed while the user was watching. Keyed on the payment log (the
// single source of truth) rather than decoding the minted invoice's hash, so it also
// catches a payer settling an older invoice — either way the money arrived.

export function settledReceivedIds(records: PaymentRecord[]): Set<string> {
  return new Set(records.filter(isSettledReceived).map((r) => r.id));
}

export function newSettledReceived(baseline: Set<string>, records: PaymentRecord[]): PaymentRecord | undefined {
  const fresh = records.filter((r) => isSettledReceived(r) && !baseline.has(r.id));
  if (fresh.length === 0) return undefined;
  return fresh.reduce((a, b) => (settleTime(b) > settleTime(a) ? b : a));
}

function isSettledReceived(r: PaymentRecord): boolean {
  return r.direction === "received" && r.status === "settled";
}

function settleTime(r: PaymentRecord): number {
  return r.settledAt ?? r.timestamp;
}
