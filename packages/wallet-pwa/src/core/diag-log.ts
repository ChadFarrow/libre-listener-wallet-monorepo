// Pure policy core for the on-device diagnostic ring buffer (spec:
// docs/superpowers/specs/2026-07-11-diag-log-design.md). DOM-free and clock-free:
// callers pass `now`, so every decision is unit-testable. The IndexedDB half lives in
// core/diag-store.ts; the console tap in core/diag-tap.ts.

export type DiagLevel = "log" | "warn" | "error" | "event";

export interface DiagEntry {
  at: number; // ms epoch
  level: DiagLevel;
  msg: string;
}

export interface DiagPolicy {
  cap: number; // max entries kept in memory (DB enforces the same cap on write)
  maxLine: number; // per-line char cap (NWC wire payloads are huge)
  batchCount: number; // flush after this many unflushed entries…
  batchMs: number; // …or this long after the first unflushed entry
  dropContains: string[]; // lines containing any of these are dropped (LDK [TRACE] spam)
}

export const DEFAULT_DIAG_POLICY: DiagPolicy = {
  cap: 4000,
  maxLine: 2000,
  batchCount: 50,
  batchMs: 2000,
  dropContains: ["[TRACE]"],
};

export class DiagBuffer {
  private policy: DiagPolicy;
  private entries: DiagEntry[] = [];
  private unflushedFrom = 0; // index of the first unflushed entry
  private firstUnflushedAt: number | undefined;

  constructor(policy: DiagPolicy = DEFAULT_DIAG_POLICY) {
    this.policy = policy;
  }

  /** Record a line (post-filter/truncation). Returns whether a flush is now due. */
  add(level: DiagLevel, msg: string, now: number): boolean {
    if (this.policy.dropContains.some((s) => msg.includes(s))) return this.flushDue(now);
    let text = msg;
    if (text.length > this.policy.maxLine) {
      const over = text.length - this.policy.maxLine;
      text = `${text.slice(0, this.policy.maxLine)}…[+${over} chars]`;
    }
    this.entries.push({ at: now, level, msg: text });
    if (this.firstUnflushedAt === undefined) this.firstUnflushedAt = now;
    if (this.entries.length > this.policy.cap) {
      const drop = this.entries.length - this.policy.cap;
      this.entries.splice(0, drop);
      this.unflushedFrom = Math.max(0, this.unflushedFrom - drop);
    }
    return this.flushDue(now);
  }

  flushDue(now: number): boolean {
    const unflushed = this.entries.length - this.unflushedFrom;
    if (unflushed <= 0) return false;
    if (unflushed >= this.policy.batchCount) return true;
    return this.firstUnflushedAt !== undefined && now - this.firstUnflushedAt >= this.policy.batchMs;
  }

  /** Hand over the pending batch (for the store) and reset the batch window. */
  drainUnflushed(): DiagEntry[] {
    const batch = this.entries.slice(this.unflushedFrom);
    this.unflushedFrom = this.entries.length;
    this.firstUnflushedAt = undefined;
    return batch;
  }

  /** Everything currently in memory (flushed + not) — the export's in-memory tail. */
  snapshot(): DiagEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
    this.unflushedFrom = 0;
    this.firstUnflushedAt = undefined;
  }

  count(): number {
    return this.entries.length;
  }
}

/** Plain-text export body: one greppable `ISO-8601 LEVEL message` line per entry. */
export function formatDiagLines(entries: DiagEntry[]): string {
  return entries.map((e) => `${new Date(e.at).toISOString()} ${e.level.toUpperCase()} ${e.msg}`).join("\n");
}
