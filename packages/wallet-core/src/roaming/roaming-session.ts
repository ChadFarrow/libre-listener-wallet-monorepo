// The roaming-session orchestrator: ties the lease (drive-lease.ts), the Drive backup, and the
// wallet controller into the boot/heartbeat/takeover/self-fence lifecycle. All I/O arrives
// through the injected ports so the whole state machine is testable with fakes; the embeddable
// widget (and the PWA's lease participation) wire the real Drive/controller implementations.
//
// Safety recap (see roaming-policy.ts + docs/roaming-protocol.md):
//   - The lease is peeked BEFORE it's claimed: a live foreign lease → blocked view (no write),
//     and the pre-claim record is what the crash-gap check runs against (claiming overwrites it).
//   - The node never starts before a second confirmation read of our own lease.
//   - On eviction (another origin claimed the wallet) the holder drains, stops, flushes its
//     backup ONLY if it's ahead of Drive (never clobber the successor), and writes a handoff ack.

import {
  CONFIRM_READ_MS,
  TAKEOVER_POLL_MS,
  TAKEOVER_WAIT_MS,
  evaluateHandoffProof,
  roamingBootDecision,
  takeoverMayProceed,
  type RoamingLeaseRecord,
} from "./roaming-policy";
import { LeaseUnreachableError, RoamingLease, RoamingLeaseHeldError } from "./drive-lease";

/** What the widget renders. Every transition is emitted through onState. */
export type RoamingViewState =
  | { view: "checking" }
  | { view: "blocked"; origin: string; expiresAt: number }
  | { view: "need-secret" } // backup found, fresh origin → prompt recovery phrase / seed
  | { view: "setup-needed" } // no wallet anywhere → send the user to the wallet app
  | { view: "moving"; waitedMs: number } // takeover in progress (waiting for the holder's flush)
  | { view: "starting" }
  | { view: "running" }
  | { view: "moved-away"; origin: string } // we were evicted; wallet now lives elsewhere
  | {
      view: "halted";
      reason: "version-gap" | "start-failed" | "restore-failed";
      message: string;
      /** Present ONLY on an unproven-handoff halt: the deliberate escape hatch for "the other
       *  device is gone for good". Restoring anyway will almost certainly force-close the channel
       *  (funds return on-chain via the sweeper), so the widget must confirm, never one-tap it. */
      override?: { staleOrigin: string };
    }
  | { view: "paused"; reason: "drive-unreachable" }
  | { view: "stopped" };

export interface RoamingPorts {
  /** Local wallet-DB inspection for this network (node may be stopped). */
  readLocal(): Promise<{ seedPresent: boolean; stateVersion: number; seedHex: string | null }>;
  /** Drive backup envelope for this network; null when absent/unreachable-as-absent. */
  fetchBackup(): Promise<string | null>;
  /** Decrypt-only verification (SDK verifyBackupEnvelope). Never throws. */
  verifyEnvelope(envelope: string, secret: string): Promise<{ ok: boolean; stateVersion?: number }>;
  /** Controller verbs. start() runs the controller's own guards (recoverOrHalt etc.). */
  startNode(): Promise<void>;
  stopNode(): Promise<void>;
  restore(envelope: string, secret: string): Promise<void>;
  /** Export + upload the backup; resolves to the flushed state_version. */
  flushBackup(): Promise<number>;
}

export interface RoamingSessionOptions {
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  confirmReadMs?: number;
  takeoverWaitMs?: number;
  takeoverPollMs?: number;
}

export class RoamingSession {
  private state: RoamingViewState = { view: "stopped" }; // nothing booted yet — boot() flips to "checking"
  /** The lease record as it stood BEFORE we claimed — this is who the PREDECESSOR is. */
  private preClaimRecord: RoamingLeaseRecord | null = null;
  /** The lease as last re-read AFTER our claim — where a predecessor's handoffAck lands. */
  private postClaimRecord: RoamingLeaseRecord | null = null;
  /** Armed only by forceRestoreAnyway(): the user declared the stale origin gone and accepted the
   *  near-certain force-close. Never set by any automatic path. */
  private overrideUnprovenHandoff = false;
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly confirmReadMs: number;
  private readonly takeoverWaitMs: number;
  private readonly takeoverPollMs: number;
  private disposed = false;

  constructor(
    private readonly lease: RoamingLease,
    private readonly ports: RoamingPorts,
    private readonly onState: (s: RoamingViewState) => void,
    opts: RoamingSessionOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.delay = opts.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.confirmReadMs = opts.confirmReadMs ?? CONFIRM_READ_MS;
    this.takeoverWaitMs = opts.takeoverWaitMs ?? TAKEOVER_WAIT_MS;
    this.takeoverPollMs = opts.takeoverPollMs ?? TAKEOVER_POLL_MS;
  }

  current(): RoamingViewState {
    return this.state;
  }

  private set(s: RoamingViewState): void {
    this.state = s;
    this.onState(s);
  }

  /**
   * The boot flow, from cold. Ends in one of: blocked / need-secret / setup-needed / running /
   * halted / paused. Never throws — every failure maps to a view state.
   */
  async boot(): Promise<RoamingViewState> {
    this.set({ view: "checking" });
    // 1. PEEK first (never write yet): a live foreign lease → blocked; and the pre-claim record
    //    is the crash-gap evidence the decision below needs.
    let peek;
    try {
      peek = await this.lease.peek();
    } catch {
      this.set({ view: "paused", reason: "drive-unreachable" });
      return this.state;
    }
    this.preClaimRecord = peek.record;
    if (peek.state === "foreignLive") {
      this.set({ view: "blocked", origin: peek.record!.origin, expiresAt: peek.record!.expiresAt });
      return this.state;
    }
    return this.continueAfterLeaseGate({ takeover: false });
  }

  /** "Move wallet here": claim over the live holder, wait for its flush, then continue. */
  async moveHere(): Promise<RoamingViewState> {
    if (this.state.view !== "blocked") return this.state;
    const previousOwner = this.preClaimRecord?.owner ?? "";
    const claimedAt = this.now();
    try {
      await this.lease.acquire({ takeover: true });
    } catch (e) {
      return this.leaseFailureState(e);
    }
    // Poll for the holder's handoff ack, up to the takeover window. The backup's Drive modifiedTime
    // is deliberately NOT consulted: it names neither the writer nor the version, so it never proved
    // anything — and since the holder uploads BEFORE it acks, believing it raced us into halting on
    // the happy path. The ack is the proof; timing out just means we stop waiting.
    for (;;) {
      const waited = this.now() - claimedAt;
      this.set({ view: "moving", waitedMs: waited });
      let record: RoamingLeaseRecord | null = null;
      try {
        record = (await this.lease.peek()).record;
      } catch {
        /* transient — the poll below decides on what we have */
      }
      const verdict = takeoverMayProceed({
        record,
        ourToken: this.lease.ownerToken,
        previousOwner,
        takeoverStartedAt: claimedAt,
        now: this.now(),
        waitMs: this.takeoverWaitMs,
      });
      if (verdict.reason === "lost") {
        // A third origin out-claimed us while we waited.
        const holder = record;
        this.preClaimRecord = holder;
        this.set({ view: "blocked", origin: holder?.origin ?? "another origin", expiresAt: holder?.expiresAt ?? this.now() });
        return this.state;
      }
      if (verdict.proceed) {
        // Hand the polled record to the proof gate as-is. It is NOT merged into preClaimRecord:
        // preClaim says who the predecessor IS, postClaim carries what (if anything) it proved.
        this.postClaimRecord = record;
        return this.continueAfterLeaseGate({ takeover: true, alreadyAcquired: true });
      }
      await this.delay(this.takeoverPollMs);
    }
  }

  /** Shared tail of boot()/moveHere(): claim (if needed) → gap check → local-vs-backup routing. */
  private async continueAfterLeaseGate(opts: { takeover: boolean; alreadyAcquired?: boolean }): Promise<RoamingViewState> {
    if (!opts.alreadyAcquired) {
      try {
        await this.lease.acquire();
      } catch (e) {
        return this.leaseFailureState(e);
      }
    }

    let local;
    let backup: string | null;
    try {
      local = await this.ports.readLocal();
      backup = await this.ports.fetchBackup();
    } catch {
      this.set({ view: "paused", reason: "drive-unreachable" });
      return this.state;
    }

    // Backup version is only readable with a secret: use the local seed when we have one;
    // a fresh origin defers the gap check to submitSecret() below.
    let backupVersion: number | null = null;
    if (backup && local.seedHex) {
      const v = await this.ports.verifyEnvelope(backup, local.seedHex);
      backupVersion = v.ok && typeof v.stateVersion === "number" ? v.stateVersion : null;
    }

    const decision = roamingBootDecision({
      lease: this.preClaimRecord,
      postClaimLease: this.postClaimRecord,
      ownerToken: this.lease.ownerToken, // pre-claim record can never be "ours" — token is fresh
      now: this.now(),
      leaseClaimed: true, // we hold the file now; the pre-claim record is proof evidence only
      backupPresent: backup !== null,
      backupStateVersion: backupVersion,
      localSeedPresent: local.seedPresent,
      localStateVersion: local.stateVersion,
      override: this.overrideUnprovenHandoff,
    });

    switch (decision.action) {
      case "blocked": // only reachable via a race; surface it
        this.set({ view: "blocked", origin: decision.origin, expiresAt: decision.expiresAt });
        return this.state;
      case "halt-version-gap":
        this.set(this.unprovenHandoffHalt(decision.staleOrigin));
        return this.state;
      case "setup-needed":
        this.set({ view: "setup-needed" });
        return this.state;
      case "restore-into-empty":
        this.pendingRestoreEnvelope = backup!;
        this.set({ view: "need-secret" });
        return this.state;
      case "start":
        return this.startGuarded();
    }
  }

  private pendingRestoreEnvelope: string | null = null;

  /** The one place the unproven-handoff halt is authored, so boot() and submitSecret() can't drift.
   *  Deliberately quotes no version count: the version delta is 0 whenever the holder died after its
   *  last heartbeat, which is the common case and the whole of issue #90 — a "0 versions behind"
   *  halt would read as a bug. */
  private unprovenHandoffHalt(staleOrigin: string): RoamingViewState {
    return {
      view: "halted",
      reason: "version-gap",
      message:
        `This wallet's last session on ${staleOrigin} didn't finish saving to the cloud. ` +
        `Open ${staleOrigin} once so it can sync, then come back here.`,
      override: { staleOrigin },
    };
  }

  /**
   * The escape hatch behind an unproven-handoff halt: the user asserts the stale origin is gone for
   * good, and accepts that the peer will almost certainly force-close the channel (funds return
   * on-chain to the recovery address via the sweeper). NOT a retry — a one-way, informed decision,
   * so the widget must confirm it rather than offer it as a second "Try again".
   *
   * Note this does NOT survive a crash before our first flush: the record still says phase "live"
   * with no ack, so the next boot halts again. That's correct — at that point we genuinely have no
   * proof — and the user can override again.
   */
  async forceRestoreAnyway(): Promise<RoamingViewState> {
    if (this.state.view !== "halted" || !this.state.override) return this.state;
    this.overrideUnprovenHandoff = true;
    // The user authorized dropping the predecessor, so stop carrying it forward to the next boot.
    await this.lease.clearPredecessor();
    if (this.pendingRestoreEnvelope) {
      // Re-ask for the secret rather than stashing the verified one for a one-click restore:
      // re-entry is itself a second deliberate act, and keeping a seed alive across a halt for UI
      // convenience is a key-lifetime smell (guardrail: absolute key isolation).
      this.set({ view: "need-secret" });
      return this.state;
    }
    return this.continueAfterLeaseGate({ takeover: true, alreadyAcquired: true });
  }

  /** The user's recovery phrase / seed for a fresh-origin restore. */
  async submitSecret(secret: string): Promise<RoamingViewState> {
    if (this.state.view !== "need-secret" || !this.pendingRestoreEnvelope) return this.state;
    const envelope = this.pendingRestoreEnvelope;
    const v = await this.ports.verifyEnvelope(envelope, secret);
    if (!v.ok) {
      // Stay on need-secret; the widget shows the error inline.
      this.set({ view: "need-secret" });
      return this.state;
    }
    // The DEFERRED half of the proof gate: a fresh origin can't read the backup's version until the
    // secret arrives, so boot() postponed the check to here. Same rule, same evidence.
    const proof = evaluateHandoffProof({
      lease: this.preClaimRecord,
      postClaimLease: this.postClaimRecord,
      backupStateVersion: typeof v.stateVersion === "number" ? v.stateVersion : null,
      localSeedPresent: false, // by construction: this path only runs with no local wallet
      localStateVersion: 0,
      override: this.overrideUnprovenHandoff,
    });
    if (!proof.proven) {
      this.set(this.unprovenHandoffHalt(proof.staleOrigin));
      return this.state;
    }
    try {
      await this.ports.restore(envelope, secret);
    } catch (e) {
      this.set({ view: "halted", reason: "restore-failed", message: (e as Error)?.message || "Restore failed" });
      return this.state;
    }
    this.pendingRestoreEnvelope = null;
    return this.startGuarded({ skipStart: true }); // restore() already started the node
  }

  private async startGuarded(opts: { skipStart?: boolean } = {}): Promise<RoamingViewState> {
    this.set({ view: "starting" });
    try {
      // Second confirmation read right before the node touches the network.
      await this.delay(this.confirmReadMs);
      await this.lease.confirmStillOurs();
    } catch (e) {
      if (opts.skipStart) {
        // The restore path already started the node — losing the lease now means fence, not start.
        await this.selfFence("lost-lease");
        return this.state;
      }
      return this.leaseFailureState(e);
    }
    if (!opts.skipStart) {
      try {
        await this.ports.startNode();
      } catch (e) {
        this.set({ view: "halted", reason: "start-failed", message: (e as Error)?.message || "Start failed" });
        return this.state;
      }
    }
    this.lease.startHeartbeat({
      onEvicted: (claimant) => void this.onEvicted(claimant),
      onOutageFence: () => void this.selfFence("drive-outage"),
    });
    this.set({ view: "running" });
    return this.state;
  }

  /** Another origin claimed the wallet: drain, stop, flush-if-ahead, ack, show moved-away. */
  private async onEvicted(claimant: RoamingLeaseRecord | null): Promise<void> {
    if (this.disposed) return;
    const origin = claimant?.origin ?? "another device";
    try {
      await this.ports.stopNode();
    } catch {
      /* stop is best-effort during eviction — the fence is what matters */
    }
    // Flush ONLY if our local state is ahead of the backup: after the takeover timeout the
    // successor may already be running + flushing, and a stale upload would clobber it.
    try {
      const local = await this.ports.readLocal();
      let backupVersion = 0;
      const envelope = await this.ports.fetchBackup();
      if (envelope && local.seedHex) {
        const v = await this.ports.verifyEnvelope(envelope, local.seedHex);
        backupVersion = v.ok && typeof v.stateVersion === "number" ? v.stateVersion : 0;
      }
      if (local.stateVersion > backupVersion) {
        const flushed = await this.ports.flushBackup();
        await this.lease.writeHandoffAck(flushed);
      } else {
        await this.lease.writeHandoffAck(local.stateVersion);
      }
    } catch {
      /* best-effort — the successor also proceeds on timeout + gap check */
    }
    this.set({ view: "moved-away", origin });
  }

  /** Stop the node because we can no longer prove we hold the lease. */
  private async selfFence(_why: "drive-outage" | "lost-lease"): Promise<void> {
    if (this.disposed) return;
    this.lease.stopHeartbeat();
    try {
      await this.ports.stopNode();
    } catch {
      /* best-effort */
    }
    this.set({ view: "paused", reason: "drive-unreachable" });
  }

  /** Clean shutdown (widget dispose / page close): stop, final flush, release the lease.
   *  The release is told exactly how far the flush got, so a failed upload leaves an honest `live`
   *  lease rather than a `released` one promising a backup that isn't there. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.lease.stopHeartbeat();
    const wasRunning = this.state.view === "running";
    try {
      let proof: { localStateVersion?: number; flushedVersion?: number } = {};
      if (wasRunning) {
        await this.ports.stopNode();
        const flushedVersion = await this.ports.flushBackup();
        proof = { localStateVersion: (await this.ports.readLocal()).stateVersion, flushedVersion };
      }
      await this.lease.release(proof);
    } catch {
      /* best-effort — an unreleased lease expires on its own */
    }
    this.set({ view: "stopped" });
  }

  private leaseFailureState(e: unknown): RoamingViewState {
    if (e instanceof RoamingLeaseHeldError) {
      this.set({ view: "blocked", origin: e.origin, expiresAt: e.expiresAt });
    } else if (e instanceof LeaseUnreachableError) {
      this.set({ view: "paused", reason: "drive-unreachable" });
    } else {
      this.set({ view: "halted", reason: "start-failed", message: (e as Error)?.message || String(e) });
    }
    return this.state;
  }
}
