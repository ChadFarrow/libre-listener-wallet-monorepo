/**
 * Default BOLT11 invoice expiry: 4 hours.
 *
 * WHY NOT 1h: a browser/no-std LDK node has no wall clock — it stamps an invoice's creation time with
 * its last-synced Bitcoin block's timestamp (`highest_seen_timestamp`). A block can legitimately be
 * mined 30–60+ minutes apart, so even a fully-synced node routinely stamps a "fresh" invoice tens of
 * minutes in the past. With a 1h expiry that invoice can look already-expired to a payer with a real
 * clock (observed live 2026-07-15: a just-minted invoice carried a 43-min-old block time). 4h absorbs
 * that lag with room to spare.
 */
export const DEFAULT_INVOICE_EXPIRY_SECONDS = 4 * 60 * 60; // 14400

/**
 * Resolve a requested invoice expiry (seconds) to a concrete value. A missing, zero, negative, or
 * non-finite request falls back to {@link DEFAULT_INVOICE_EXPIRY_SECONDS}; a positive request is
 * honoured (floored to whole seconds).
 */
export function resolveInvoiceExpiry(requested?: number): number {
  if (typeof requested === "number" && Number.isFinite(requested) && requested > 0) {
    return Math.floor(requested);
  }
  return DEFAULT_INVOICE_EXPIRY_SECONDS;
}
