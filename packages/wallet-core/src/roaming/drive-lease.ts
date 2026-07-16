// The cross-origin roaming lease over a Drive appDataFolder file. Drive has no compare-and-swap,
// so acquire is write-then-read-back-verify (+ a settle delay, + a second confirmation read the
// session performs right before startNode) — the losing writer of a near-simultaneous race sees
// the other's token on read-back and backs off. All DECISIONS live in roaming-policy.ts; this
// module is the I/O lifecycle (acquire / heartbeat / ack / release), with the store, clock, and
// delays injected so tests drive deterministic interleavings over an in-memory fake.

import {
  ACQUIRE_SETTLE_JITTER_MS,
  ACQUIRE_SETTLE_MS,
  ROAMING_LEASE_MS,
  ROAMING_RENEW_MS,
  buildLeaseRecord,
  heartbeatDecision,
  leaseState,
  parseLeaseRecord,
  shouldSelfFenceOnOutage,
  type RoamingLeaseRecord,
  type RoamingLeaseState,
} from "./roaming-policy";

/** Storage the lease rides on. The Drive impl is DriveLeaseStore; tests inject an in-memory fake.
 *  read() resolves null when the file is absent; both reject on transport failure. */
export interface LeaseStore {
  read(): Promise<RoamingLeaseRecord | null>;
  write(record: RoamingLeaseRecord): Promise<void>;
  /** Best-effort SYNCHRONOUSLY-ISSUED write for the pagehide path — nothing may be awaited before
   *  the request goes out, or the page dies first and it is never sent at all. Returns false when it
   *  could not be issued; the caller must treat that as "the write did not happen". Optional: stores
   *  without a keepalive-capable transport simply don't offer it. */
  writeSyncKeepalive?(record: RoamingLeaseRecord): boolean;
}

/** One lease file per network — pinned in storage-contract.test.ts (a renamed file would let two
 *  app versions coordinate on different files, i.e. not coordinate at all). */
export function leaseFilename(network: string): string {
  return `libre-wallet-lease-${network}.json`;
}

/** Thrown when another origin holds a live lease (boot shows the blocked view / Move-here). */
export class RoamingLeaseHeldError extends Error {
  readonly code = "ROAMING_LEASE_HELD";
  constructor(
    readonly origin: string,
    readonly expiresAt: number,
  ) {
    super(`ROAMING_LEASE_HELD: the wallet is active on ${origin}`);
    this.name = "RoamingLeaseHeldError";
  }
}

/** Thrown when the lease store can't be reached during acquire — FAIL CLOSED (no node). */
export class LeaseUnreachableError extends Error {
  readonly code = "ROAMING_LEASE_UNREACHABLE";
  constructor(cause: unknown) {
    super(`ROAMING_LEASE_UNREACHABLE: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "LeaseUnreachableError";
  }
}

export interface RoamingLeaseOptions {
  ownerToken: string;
  origin: string;
  appName?: string;
  /** Holder's current local state_version — stamped into every write so a successor can detect a
   *  crash gap (see roaming-policy). Read fresh at each write. */
  getStateVersion: () => Promise<number> | number;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  random?: () => number; // [0,1) — jitter source
  leaseMs?: number;
  renewMs?: number;
}

export class RoamingLease {
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly leaseMs: number;
  readonly renewMs: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private firstFailureAt: number | null = null;
  private fenced = false;
  /** Our last written record. The pagehide path builds from this because it cannot await a read. */
  private lastWritten: RoamingLeaseRecord | null = null;

  constructor(
    private readonly store: LeaseStore,
    private readonly opts: RoamingLeaseOptions,
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.delay = opts.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.leaseMs = opts.leaseMs ?? ROAMING_LEASE_MS;
    this.renewMs = opts.renewMs ?? ROAMING_RENEW_MS;
  }

  get ownerToken(): string {
    return this.opts.ownerToken;
  }

  /** Read + classify the current lease. Transport failure → LeaseUnreachableError. */
  async peek(): Promise<{ record: RoamingLeaseRecord | null; state: RoamingLeaseState }> {
    let record: RoamingLeaseRecord | null;
    try {
      record = await this.store.read();
    } catch (e) {
      throw new LeaseUnreachableError(e);
    }
    return { record, state: leaseState(record, this.opts.ownerToken, this.now()) };
  }

  private async writeOurRecord(
    previous: RoamingLeaseRecord | null,
    opts: { clearPredecessor?: boolean } = {},
  ): Promise<RoamingLeaseRecord> {
    const record = buildLeaseRecord({
      ownerToken: this.opts.ownerToken,
      origin: this.opts.origin,
      appName: this.opts.appName,
      now: this.now(),
      previous,
      heartbeatStateVersion: await this.opts.getStateVersion(),
      leaseMs: this.leaseMs,
      clearPredecessor: opts.clearPredecessor,
    });
    await this.store.write(record);
    this.lastWritten = record;
    return record;
  }

  /** Drop the carried unproven predecessor — ONLY on the user's explicit override (they declared the
   *  other device gone and accepted the force-close). Best-effort: the override is already armed in
   *  memory, so a failed write costs the next boot a re-halt, never safety. */
  async clearPredecessor(): Promise<void> {
    try {
      const record = await this.store.read();
      if (!record || record.owner !== this.opts.ownerToken) return;
      await this.writeOurRecord(record, { clearPredecessor: true });
    } catch {
      /* best-effort — a re-halt on the next boot is the safe failure */
    }
  }

  /**
   * Claim the lease. `takeover: true` claims OVER a live foreign lease (the user chose "Move
   * wallet here"); otherwise a live foreign lease throws RoamingLeaseHeldError. After the write,
   * waits the settle delay and read-back-verifies: a concurrent claimant whose write landed after
   * ours wins the file, we see their token and back off. Fail closed on any transport error.
   */
  async acquire(opts: { takeover?: boolean } = {}): Promise<RoamingLeaseRecord> {
    const { record, state } = await this.peek();
    if (state === "foreignLive" && !opts.takeover) {
      throw new RoamingLeaseHeldError(record!.origin, record!.expiresAt);
    }
    try {
      await this.writeOurRecord(record);
    } catch (e) {
      throw new LeaseUnreachableError(e);
    }
    await this.delay(ACQUIRE_SETTLE_MS + Math.floor(this.random() * ACQUIRE_SETTLE_JITTER_MS));
    const after = await this.peek();
    if (after.state !== "ours") {
      const holder = after.record;
      throw new RoamingLeaseHeldError(holder?.origin ?? "another origin", holder?.expiresAt ?? this.now());
    }
    return after.record!;
  }

  /** The second confirmation read, performed by the session right before startNode(). */
  async confirmStillOurs(): Promise<void> {
    const { record, state } = await this.peek();
    if (state !== "ours") {
      throw new RoamingLeaseHeldError(record?.origin ?? "another origin", record?.expiresAt ?? this.now());
    }
  }

  /**
   * One heartbeat: READ FIRST (eviction beats renewal — a claimant's write must be seen, never
   * blindly overwritten), then renew. Returns what happened so the session (and tests) can drive
   * ticks directly; startHeartbeat wires this to an interval. Transport failures are tolerated
   * until they span the lease window — then the holder must assume the lease lapsed and fence.
   */
  async tick(handlers: { onEvicted: (claimant: RoamingLeaseRecord | null) => void; onOutageFence: () => void }): Promise<
    "renewed" | "evicted" | "failed" | "fenced"
  > {
    if (this.fenced) return "fenced";
    let record: RoamingLeaseRecord | null;
    try {
      record = await this.store.read();
    } catch {
      return this.noteFailure(handlers);
    }
    if (heartbeatDecision(record, this.opts.ownerToken) === "evicted") {
      this.stopHeartbeat();
      handlers.onEvicted(record);
      return "evicted";
    }
    try {
      await this.writeOurRecord(record);
    } catch {
      return this.noteFailure(handlers);
    }
    this.firstFailureAt = null;
    return "renewed";
  }

  private noteFailure(handlers: { onOutageFence: () => void }): "failed" | "fenced" {
    if (this.firstFailureAt === null) this.firstFailureAt = this.now();
    if (shouldSelfFenceOnOutage(this.firstFailureAt, this.now(), this.leaseMs)) {
      this.fenced = true;
      this.stopHeartbeat();
      handlers.onOutageFence();
      return "fenced";
    }
    return "failed";
  }

  startHeartbeat(handlers: { onEvicted: (claimant: RoamingLeaseRecord | null) => void; onOutageFence: () => void }): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.tick(handlers);
    }, this.renewMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /** Evicted holder's post-flush ack: merged into the CURRENT record without touching its owner
   *  (which is the claimant by now). Best-effort — the claimant also proceeds on backup mtime. */
  async writeHandoffAck(flushedVersion: number): Promise<void> {
    try {
      const record = await this.store.read();
      if (!record) return;
      await this.store.write({
        ...record,
        seq: record.seq + 1,
        handoffAck: { from: this.opts.ownerToken, flushedVersion, at: this.now() },
      });
    } catch {
      /* best-effort — the takeover proceeds on the backup's modifiedTime instead */
    }
  }

  /** Clean stop — only if we still own the lease. Marks it `released` (immediately claimable, and
   *  the successor knows the final flush happened) ONLY when the backup provably holds everything we
   *  have. `released` is the strongest proof a successor gets, so claiming it while our last flush
   *  is behind local state would hand the next origin a stale backup to restore onto a live channel
   *  — the #90 force-close, dressed as a clean handoff. When we can't prove it, stay honest: leave
   *  the lease `live` at our TRUE final version so the successor halts and asks the user to reopen
   *  this origin. Omitting the versions asserts nothing is pending (dispose() flushes first).
   *  Best-effort. */
  async release(opts: { localStateVersion?: number; flushedVersion?: number } = {}): Promise<void> {
    this.stopHeartbeat();
    try {
      const record = await this.store.read();
      if (!record || record.owner !== this.opts.ownerToken) return;
      const local = opts.localStateVersion ?? (await this.opts.getStateVersion());
      const clean = (opts.flushedVersion ?? local) >= local;
      await this.store.write({
        ...record,
        seq: record.seq + 1,
        expiresAt: clean ? this.now() : record.expiresAt,
        phase: clean ? "released" : "live",
        heartbeatStateVersion: local,
      });
    } catch {
      /* best-effort — an unreleased lease simply expires after leaseMs */
    }
  }

  /**
   * The pagehide path: issue our final lease write SYNCHRONOUSLY, since a page dies long before any
   * awaited work resolves (the browser finishes an in-flight keepalive request, but cannot start
   * one for you). Same honesty rule as release(): `released` only when the backup provably holds
   * everything we have, otherwise `live` at our true final version so the successor halts.
   *
   * Builds from our last written record rather than a fresh read — reading would be an await.
   * Returns false when nothing could be issued (no record written this page-life, or the store has
   * no keepalive transport): NOT a silent success, the close simply wasn't recorded and the
   * successor will fall back to the proof gate, which halts.
   */
  releaseSyncKeepalive(opts: { localStateVersion: number; flushedVersion: number }): boolean {
    this.stopHeartbeat();
    const last = this.lastWritten;
    if (!last || !this.store.writeSyncKeepalive) return false;
    const clean = opts.flushedVersion >= opts.localStateVersion;
    return this.store.writeSyncKeepalive({
      ...last,
      seq: last.seq + 1,
      // Never extend a lease we're abandoning; never shorten one we're admitting state on.
      expiresAt: clean ? this.now() : last.expiresAt,
      phase: clean ? "released" : "live",
      heartbeatStateVersion: opts.localStateVersion,
    });
  }
}

/** LeaseStore over the Drive appDataFolder, via the generic file verbs in drive-backup.ts.
 *  Injected as functions so this module never imports the OAuth machinery directly. */
export function driveLeaseStore(
  network: string,
  io: {
    readFile: (name: string) => Promise<{ contents: string } | null>;
    writeFile: (name: string, contents: string) => Promise<void>;
    /** Synchronously-issued keepalive overwrite for pagehide; false when it couldn't be issued.
     *  Optional so existing callers (and tests) that only need async I/O still satisfy the type. */
    writeFileSyncKeepalive?: (name: string, contents: string) => boolean;
  },
): LeaseStore {
  const name = leaseFilename(network);
  const sync = io.writeFileSyncKeepalive;
  return {
    async read() {
      const f = await io.readFile(name);
      return parseLeaseRecord(f?.contents ?? null);
    },
    async write(record) {
      await io.writeFile(name, JSON.stringify(record));
    },
    ...(sync ? { writeSyncKeepalive: (record: RoamingLeaseRecord) => sync(name, JSON.stringify(record)) } : {}),
  };
}
