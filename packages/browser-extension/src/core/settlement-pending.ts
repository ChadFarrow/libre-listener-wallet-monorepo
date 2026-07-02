// Distinguishes a payment that is still in flight from one that never left the node.
//
// The offscreen host awaits settlement with a 90s cap; when that cap fires, send_payment has
// already been dispatched (with retry attempts) and typically settles moments later. The
// background must NOT refund the spending cap on that timeout — a late settlement is a real spend.
// A refund is only correct for a pre-initiation failure (bad invoice, no route, send_payment
// returned not-ok). This tiny, dependency-free module is the shared marker both sides agree on.

export const SETTLEMENT_PENDING_MARKER = "SETTLEMENT_PENDING";

// The user-facing timeout message (carries the machine-readable marker for isSettlementPending).
export function settlementPendingMessage(): string {
  return `Payment initiated but not yet settled; it may still complete. [${SETTLEMENT_PENDING_MARKER}]`;
}

// True when an error came from the settlement-await timeout (payment still in flight).
export function isSettlementPending(errMessage: string | undefined | null): boolean {
  return typeof errMessage === "string" && errMessage.includes(SETTLEMENT_PENDING_MARKER);
}
