// Read-only transaction data the embed exposes to the host app (boostmebitch et al.) so it can
// render its OWN transaction feed — the embed draws no history UI itself. The source of truth is
// the SDK PaymentLogger, reached via WalletController.getPayments(); these are the pure mappers +
// the newly-settled diff behind MountHandle.getTransactions()/onTransaction().

import type { PaymentRecord } from "@libre/shared";

/**
 * A single payment as exposed to host apps. Maps PaymentRecord 1:1 MINUS `preimage`: a feed needs
 * no payment receipts, and although the host shares the origin (this is convenience, not a security
 * boundary), leaving receipts out of the display API is least-surprise. Revisit if a real need for
 * proof-of-payment appears.
 */
export interface TxView {
  /** Payment hash hex. */
  id: string;
  direction: "sent" | "received";
  status: "pending" | "settled" | "failed";
  amountSats: number;
  /** Routing fee in sats (outbound settled only). */
  feeSats?: number;
  /** ms epoch at record creation. */
  timestamp: number;
  /** ms epoch when the payment settled. */
  settledAt?: number;
  /** Destination node pubkey (sent). */
  counterparty?: string;
  type?: "keysend" | "bolt11";
  /** Best-effort human note (a boostagram's `podcast · episode` or message). */
  note?: string;
}

/** Map one record to its display view, dropping the preimage. */
export function toTxView(r: PaymentRecord): TxView {
  return {
    id: r.id,
    direction: r.direction,
    status: r.status,
    amountSats: r.amountSats,
    feeSats: r.feeSats,
    timestamp: r.timestamp,
    settledAt: r.settledAt,
    counterparty: r.counterparty,
    type: r.type,
    note: r.note,
  };
}

/** Map a whole log to newest-first views. Self-contained: does not rely on the source's ordering. */
export function toTxViews(records: PaymentRecord[]): TxView[] {
  return records.map(toTxView).sort((a, b) => b.timestamp - a.timestamp);
}

export interface TransactionFeed {
  /**
   * Feed the current full log. The FIRST call baselines existing settled history (returns nothing —
   * that history is not "new"); every later call returns the settled records not seen before. Only
   * settled records are ever emitted — a feed fires on settlement, not on a pending intent.
   */
  ingest(records: PaymentRecord[]): TxView[];
}

/** Stateful newly-settled tracker behind onTransaction. Pure of I/O — driven by ingest(). */
export function makeTransactionFeed(): TransactionFeed {
  const seen = new Set<string>();
  let baselined = false;
  return {
    ingest(records: PaymentRecord[]): TxView[] {
      const settled = records.filter((r) => r.status === "settled");
      if (!baselined) {
        for (const r of settled) seen.add(r.id);
        baselined = true;
        return [];
      }
      const fresh: TxView[] = [];
      for (const r of settled) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        fresh.push(toTxView(r));
      }
      return fresh;
    },
  };
}
