// A durable, forward-only record of a single Lightning payment (sent or received),
// captured at event time by the SDK's PaymentLogger. This is the shared source of
// truth behind both the app's transaction-history UI and the NWC `list_transactions`
// method — see payment-log.ts (SDK) and nwc-transactions.ts.

export type PaymentDirection = "sent" | "received";

// pending  — outbound intent registered, not yet settled/failed by LDK.
// settled  — Event_PaymentSent (outbound) or Event_PaymentClaimed (inbound).
// failed   — Event_PaymentFailed (outbound only).
export type PaymentStatus = "pending" | "settled" | "failed";

export interface PaymentRecord {
  /** Payment hash hex — the dedupe/finalize key (also the on-disk `tx_<id>` key). */
  id: string;
  direction: PaymentDirection;
  status: PaymentStatus;
  /** Amount in sats. 0 when unknown (a Sent event with no registered outbound intent). */
  amountSats: number;
  /** Routing fee in sats (outbound only), from Event_PaymentSent. */
  feeSats?: number;
  /** ms epoch (Date.now()) at record creation — LDK events carry no timestamp. */
  timestamp: number;
  /** ms epoch when the payment settled. */
  settledAt?: number;
  /** Destination node pubkey (sent). */
  counterparty?: string;
  type?: "keysend" | "bolt11";
  /** Best-effort human note (e.g. a boostagram's `podcast · episode` or message). */
  note?: string;
  /** Payment preimage hex, when cheaply available (outbound Event_PaymentSent). */
  preimage?: string;
}
