import type { BoostRecord, PaymentRecord } from "@libre/shared";
import type { SecureStorageProvider, Logger } from "./index";

// Forward-only, on-device payment history. The single source of truth behind both the
// app's transaction-history UI (via getPayments) and NWC `list_transactions`.
//
// Storage model: ONE key per record, `tx_<paymentHashHex>` (same untracked-prefix
// pattern as `preimage_*`), so there is no growing single-blob rewrite and nothing is
// ever trimmed — history is unbounded. The full list is loaded into memory once at
// start(); each mutation rewrites only that one record's key (best-effort, never throws
// into a payment path). Records are keyed by payment hash so an outbound `pending`
// record is upserted in place when it settles/fails.
//
// The LDK `instanceof` event demux lives in the wallet (index.ts, minification-safe);
// this class exposes plain methods so it's unit-testable without a real node.

export const TX_KEY_PREFIX = "tx_";
const txKey = (id: string): string => `${TX_KEY_PREFIX}${id}`;

// TLV key carrying the bLIP-10 boostagram JSON (see @libre/shared encodeV4VTlvs).
const BOOST_TLV_KEY = 7629169;

export interface PaymentLoggerDeps {
  storage: SecureStorageProvider;
  logger?: Logger;
}

export class PaymentLogger {
  private storage: SecureStorageProvider;
  private logger?: Logger;
  private records: Map<string, PaymentRecord> = new Map();
  private loaded = false;

  constructor(deps: PaymentLoggerDeps) {
    this.storage = deps.storage;
    this.logger = deps.logger;
  }

  /** Rehydrate the in-memory list from every persisted `tx_*` key. Best-effort. */
  async load(): Promise<void> {
    this.loaded = true;
    if (!this.storage.keys) {
      this.logger?.warn?.("[PaymentLog] storage has no keys() — history disabled for this provider");
      return;
    }
    try {
      const keys = (await this.storage.keys()).filter((k) => k.startsWith(TX_KEY_PREFIX));
      for (const key of keys) {
        try {
          const raw = await this.storage.getItem(key);
          if (!raw) continue;
          const rec = JSON.parse(raw) as PaymentRecord;
          if (rec && typeof rec.id === "string") this.records.set(rec.id, rec);
        } catch (e) {
          this.logger?.warn?.(`[PaymentLog] skipping unreadable record ${key}: ${e instanceof Error ? e.message : e}`);
        }
      }
    } catch (e) {
      this.logger?.error?.(`[PaymentLog] load failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Register an outbound payment at initiation (amount/destination/note known now). */
  notePending(rec: PaymentRecord): void {
    // Don't clobber a record that already settled (e.g. a retry noting the same hash).
    const existing = this.records.get(rec.id);
    if (existing && existing.status !== "pending") return;
    this.upsert({ ...rec, status: rec.status ?? "pending" });
  }

  /** Outbound settled: finalize the matching pending record (or record a minimal one). */
  recordSent(hashHex: string, feeSats: number, preimageHex?: string): void {
    const now = Date.now();
    const existing = this.records.get(hashHex);
    if (existing) {
      this.upsert({ ...existing, status: "settled", feeSats, settledAt: now, ...(preimageHex ? { preimage: preimageHex } : {}) });
    } else {
      // A send that didn't register an intent (unknown amount) — keep it so nothing is dropped.
      this.upsert({
        id: hashHex,
        direction: "sent",
        status: "settled",
        amountSats: 0,
        feeSats,
        timestamp: now,
        settledAt: now,
        ...(preimageHex ? { preimage: preimageHex } : {}),
      });
    }
  }

  /** Outbound failed: mark the matching pending record failed (best-effort). */
  recordFailed(hashHex: string): void {
    const existing = this.records.get(hashHex);
    if (!existing) return;
    this.upsert({ ...existing, status: "failed" });
  }

  /** Inbound claimed: record a settled received payment. */
  recordReceived(hashHex: string, amountSats: number): void {
    const now = Date.now();
    const existing = this.records.get(hashHex);
    // An inbound claim always wins over any stale entry for this hash.
    this.upsert({
      id: hashHex,
      direction: "received",
      status: "settled",
      amountSats,
      timestamp: existing?.timestamp ?? now,
      settledAt: now,
    });
  }

  /** Newest-first snapshot of all records. */
  getRecords(): PaymentRecord[] {
    return [...this.records.values()].sort((a, b) => b.timestamp - a.timestamp);
  }

  private upsert(rec: PaymentRecord): void {
    this.records.set(rec.id, rec);
    // Fire-and-forget: a persist failure must never break a payment path.
    void this.storage.setItem(txKey(rec.id), JSON.stringify(rec)).catch((e) => {
      this.logger?.error?.(`[PaymentLog] persist ${rec.id} failed: ${e instanceof Error ? e.message : e}`);
    });
  }

  /** Whether load() has run (used by callers to lazily load on first read). */
  isLoaded(): boolean {
    return this.loaded;
  }
}

/**
 * Best-effort short note from a keysend's custom TLV records: parse the bLIP-10
 * boostagram (key 7629169, UTF-8 JSON) into a human string like `podcast · episode`
 * or its message. Tolerates missing/malformed data (returns undefined).
 */
export function boostNoteFromCustomRecords(
  customRecords?: Record<number, string | Uint8Array>
): string | undefined {
  if (!customRecords) return undefined;
  const raw = customRecords[BOOST_TLV_KEY];
  if (raw == null) return undefined;
  try {
    const json = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const boost = JSON.parse(json) as BoostRecord;
    const parts: string[] = [];
    if (boost.podcast) parts.push(boost.podcast);
    if (boost.episode) parts.push(boost.episode);
    if (parts.length) return parts.join(" · ");
    if (boost.message) return boost.message;
    if (boost.name) return boost.name;
    return undefined;
  } catch {
    return undefined;
  }
}
