// Pure mapping from the wallet's PaymentRecord log to NIP-47 `list_transactions`
// result objects (what Alby Go and other NWC clients render as history). Kept
// side-effect-free so the unit conversions — the main risk here — are testable
// without a live node.
import type { PaymentRecord } from "./payment-record";

// A NIP-47 transaction object. Amounts are in **millisats**; times in **unix seconds**.
export interface NwcTransaction {
  type: "incoming" | "outgoing";
  invoice?: string;
  description?: string;
  description_hash?: string;
  preimage?: string;
  payment_hash: string;
  amount: number; // msat
  fees_paid: number; // msat
  created_at: number; // unix seconds
  settled_at?: number; // unix seconds; present only once settled
}

export interface ListTransactionsParams {
  from?: number; // unix seconds (inclusive lower bound on created_at)
  until?: number; // unix seconds (inclusive upper bound on created_at)
  limit?: number;
  offset?: number;
  unpaid?: boolean;
  type?: "incoming" | "outgoing";
}

const DEFAULT_LIMIT = 50;

const toSeconds = (ms: number): number => Math.floor(ms / 1000);
const directionToType = (d: PaymentRecord["direction"]): NwcTransaction["type"] =>
  d === "sent" ? "outgoing" : "incoming";

/**
 * Map + filter payment records into NIP-47 transactions, newest first.
 * Filtering order: type/time filters → offset → limit (NIP-47 pagination semantics).
 */
export function paymentRecordsToNwcTransactions(
  records: PaymentRecord[],
  params: ListTransactionsParams = {}
): NwcTransaction[] {
  const { from, until, limit, offset, type, unpaid } = params;

  const filtered = records
    // NIP-47 has no representation for a FAILED payment — emitting one (no settled_at)
    // makes a client like Alby Go render it as a perpetually-pending tx. Drop failed always.
    // `pending` records are "unpaid": excluded by default, included only when unpaid:true.
    .filter((r) => r.status !== "failed")
    .filter((r) => (unpaid === true ? true : r.status === "settled"))
    .filter((r) => (type ? directionToType(r.direction) === type : true))
    .filter((r) => (from != null ? toSeconds(r.timestamp) >= from : true))
    .filter((r) => (until != null ? toSeconds(r.timestamp) <= until : true))
    // newest first
    .sort((a, b) => b.timestamp - a.timestamp);

  const start = offset && offset > 0 ? offset : 0;
  const count = limit && limit > 0 ? limit : DEFAULT_LIMIT;
  const page = filtered.slice(start, start + count);

  return page.map((r) => {
    const tx: NwcTransaction = {
      type: directionToType(r.direction),
      payment_hash: r.id,
      amount: Math.max(0, Math.round(r.amountSats * 1000)),
      fees_paid: Math.max(0, Math.round((r.feeSats ?? 0) * 1000)),
      created_at: toSeconds(r.timestamp),
    };
    if (r.note) tx.description = r.note;
    if (r.preimage) tx.preimage = r.preimage;
    if (r.status === "settled") tx.settled_at = toSeconds(r.settledAt ?? r.timestamp);
    return tx;
  });
}
