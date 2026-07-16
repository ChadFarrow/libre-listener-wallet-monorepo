// Pure decisions for the ROAMING wallet: one wallet (seed + channel state) that MOVES between
// origins (the wallet PWA, an embedding site) via the Drive backup, with a Drive-file lease as the
// cross-origin single-instance guard. Lightning channel state may only ever live in ONE running
// node — two live copies is a force-close (see CLAUDE.md guardrails) — and Web Locks only cover a
// single origin, so the lease is the ordering signal between origins.
//
// Drive has no compare-and-swap, so the I/O layer (drive-lease.ts) uses write-then-read-back-verify
// with settle delays; THIS module only decides. It reuses the shared cross-DEVICE lease policy
// (evaluateDeviceLease) — same semantics, different substrate.
//
// Deliberate policy inversions vs. the VSS device lease (which is advisory / reliability-first):
//   - Lease unreachable at boot → FAIL CLOSED (no lease visibility ⇒ no node). A paused wallet is
//     an inconvenience; two live nodes is a force-close.
//   - Renewals failing for longer than the lease length → the holder SELF-FENCES (stops) because
//     another origin may now legitimately believe the lease lapsed and take over.
//   - Restoring the backup over a predecessor's state requires POSITIVE PROOF that the backup holds
//     its final state (evaluateHandoffProof). Silence is not proof.
//
// That last rule replaced a "crash-gap check" that compared the predecessor's last-advertised
// state_version against the backup's and halted when advertised was HIGHER. It was the wrong shape:
// a lease record is a lower bound on its writer's real state, never an upper one. A holder that
// dies AFTER its last 40s heartbeat leaves advertised == backup, so the gap it left was exactly the
// gap the check couldn't see — and it force-closed a live mainnet channel (issue #90). Proof now
// comes only from the predecessor itself (phase "released" / a handoffAck) or from our own local
// state; nothing a claimant writes can manufacture it, so a reload or "Try again" re-derives the
// same halt rather than laundering it away.

import { DEVICE_LEASE_MS, DEVICE_LEASE_RENEW_MS, evaluateDeviceLease } from "@libre/shared";

export const ROAMING_LEASE_MS = DEVICE_LEASE_MS; // 120s — same window as the VSS device lease
export const ROAMING_RENEW_MS = DEVICE_LEASE_RENEW_MS; // 40s heartbeat
/** Base settle delay between the acquire write and its read-back verification (plus jitter). */
export const ACQUIRE_SETTLE_MS = 2_000;
export const ACQUIRE_SETTLE_JITTER_MS = 2_000;
/** Second confirmation read this long after a verified acquire, immediately before startNode(). */
export const CONFIRM_READ_MS = 5_000;
/** How long a takeover waits for the previous holder's handoff ack / backup flush before
 *  proceeding through the version-gap check (holder self-fences within one 40s heartbeat). */
export const TAKEOVER_WAIT_MS = 90_000;
export const TAKEOVER_POLL_MS = 5_000;

export interface RoamingLeaseRecord {
  v: 1;
  owner: string; // random per-session token (NOT a device id — a reload mints a new one)
  origin: string; // where the wallet is running, for the "active on <origin>" UI
  appName?: string;
  acquiredAt: number;
  expiresAt: number;
  seq: number; // bumped on every write by the writer (diagnostic ordering)
  /** The holder's LOCAL state_version as of its last write. A LOWER BOUND on its real state, never
   *  an upper one — anything it advanced after this write is invisible here. Treat accordingly:
   *  it can prove we're BEHIND, it can never prove we're current. */
  heartbeatStateVersion: number;
  phase: "live" | "released";
  /** Written by an evicted holder after its final flush, WITHOUT changing owner — the claimant
   *  polls for this before restoring. Together with `phase: "released"`, the only positive proof
   *  that the Drive backup holds a predecessor's final state. */
  handoffAck?: { from: string; flushedVersion: number; at: number };
  /** The prior holder we took the lease FROM without proof its final flush landed. Carried through
   *  every one of OUR writes, so it survives a reload — which `owner` cannot, since ownerToken is
   *  per-page-life ("is this record mine?" is unanswerable after a refresh). Without this, our own
   *  claim stamps its local version (0 on a fresh origin) over the predecessor's and a reload reads
   *  back the zeroed record as gospel: that is how issue #90's "Try again" walked past the halt.
   *  Cleared only by a proven handoff or the user's explicit override. */
  unprovenPredecessor?: { owner: string; origin: string; advertisedVersion: number; since: number };
}

/** Positive evidence that the Drive backup is CURRENT with respect to a prior holder. Every
 *  variant is authored by the PREDECESSOR (released / ack) or by our own local state — never by a
 *  claimant's write. That is what makes the halt retry-safe: our claim always writes phase "live"
 *  and never an ack, so re-booting or reloading re-derives the same verdict instead of laundering
 *  it away. */
export type HandoffProof =
  | { proven: true; via: "no-predecessor" | "released" | "ack" | "local-state" | "override" }
  | { proven: false; staleOrigin: string; advertisedVersion: number; backupVersion: number };

export type RoamingLeaseState = "absent" | "ours" | "foreignLive" | "foreignExpired" | "released";

/** Classify the stored lease relative to us. "released" and "foreignExpired" are both claimable;
 *  they're distinguished so the UI can say "cleanly handed off" vs "previous session crashed". */
export function leaseState(
  record: RoamingLeaseRecord | null | undefined,
  ownerToken: string,
  now: number,
): RoamingLeaseState {
  if (!record) return "absent";
  if (record.owner === ownerToken) return "ours";
  if (record.phase === "released") return "released";
  // evaluateDeviceLease: "acquire" = expired/absent, "blocked" = live foreign lease.
  const d = evaluateDeviceLease(record, ownerToken, now);
  return d === "blocked" ? "foreignLive" : "foreignExpired";
}

export type RoamingBootDecision =
  | { action: "blocked"; origin: string; expiresAt: number } // live lease elsewhere → offer Move-here
  | { action: "halt-version-gap"; staleOrigin: string; missingVersions: number; overridable: true } // no proof the backup is current
  | { action: "restore-into-empty" } // no local wallet, backup exists → prompt secret, importState
  | { action: "setup-needed" } // no local wallet, no backup → send the user to the wallet app
  | { action: "start" }; // local wallet present → startNode() (its internal guards do the rest)

export interface RoamingBootInputs {
  /** The lease record AS PEEKED BEFORE CLAIMING — post-claim it identifies the predecessor. */
  lease: RoamingLeaseRecord | null;
  ownerToken: string;
  now: number;
  /** True when the caller has ALREADY claimed (written) the lease — the pre-claim record can then
   *  never mean "blocked" (we own the file); it only feeds the handoff-proof check. */
  leaseClaimed?: boolean;
  /** The lease as last re-read AFTER our claim (the takeover poll), which is where a predecessor's
   *  ack lands. Null/absent on the plain-boot path — an expired holder is not going to ack. */
  postClaimLease?: RoamingLeaseRecord | null;
  /** Whether a Drive backup file exists for this network, and its state_version if known.
   *  (Version may be null for older backups or when only presence was probed.) */
  backupPresent: boolean;
  backupStateVersion: number | null;
  /** Local storage inspection for this network's wallet DB. */
  localSeedPresent: boolean;
  localStateVersion: number;
  /** The user's explicit, informed escape hatch: they assert the stale origin is gone for good and
   *  accept the near-certain force-close. Never set by any automatic path. */
  override?: boolean;
}

/** The highest state_version a predecessor is KNOWN to have reached — its own last write, or the
 *  high-water mark carried forward from a chain of unproven claims before it (A dies → B claims and
 *  halts → B reloads → C claims: C must still see A's version, not B's zero). */
export function advertisedVersionOf(record: RoamingLeaseRecord): number {
  return Math.max(record.heartbeatStateVersion || 0, record.unprovenPredecessor?.advertisedVersion ?? 0);
}

export interface HandoffProofInputs {
  /** The lease as PEEKED BEFORE our claim — this is who the predecessor IS. */
  lease: RoamingLeaseRecord | null;
  postClaimLease?: RoamingLeaseRecord | null;
  backupStateVersion: number | null;
  localSeedPresent: boolean;
  localStateVersion: number;
  override?: boolean;
}

/**
 * Can we prove the Drive backup holds the predecessor's final state? Restoring without that proof
 * puts a stale node on a live channel, whose peer then proves we've fallen behind and force-closes
 * it (issue #90). A dead holder leaves no evidence either way, so silence must read as "no" —
 * an annoying, self-healing halt is recoverable; a force-close is not.
 */
export function evaluateHandoffProof(i: HandoffProofInputs): HandoffProof {
  if (i.override) return { proven: true, via: "override" };
  if (!i.lease) return { proven: true, via: "no-predecessor" };
  if (i.lease.phase === "released") return { proven: true, via: "released" };

  // The predecessor acked OUR takeover after its final flush — but only trust the ack as far as the
  // backup actually goes: `?? -1` makes an unreadable backup fail the test rather than pass it.
  const ack = i.postClaimLease?.handoffAck;
  if (ack && ack.from === i.lease.owner && ack.flushedVersion <= (i.backupStateVersion ?? -1)) {
    return { proven: true, via: "ack" };
  }

  // We ARE the origin holding the missing state (origin A reopening) → start; our own flush catches
  // Drive up. The localSeedPresent gate is load-bearing: without it a fresh origin scores 0 >= 0
  // against its own zeroed claim and walks straight back into #90.
  const advertised = advertisedVersionOf(i.lease);
  if (i.localSeedPresent && i.localStateVersion >= advertised) {
    return { proven: true, via: "local-state" };
  }

  return {
    proven: false,
    staleOrigin: i.lease.unprovenPredecessor?.origin ?? i.lease.origin,
    advertisedVersion: advertised,
    backupVersion: i.backupStateVersion ?? 0,
  };
}

/**
 * The roaming half of the boot decision. Deliberately does NOT re-implement the local
 * stale/rollback/foreign-backup guards — those already live in the controller's start path
 * (recoverOrHalt / restore-guard / state-version-mirror) and run inside "start". This decides
 * only what roaming adds: the lease gate, the handoff-proof gate, and empty-vs-populated local.
 */
export function roamingBootDecision(i: RoamingBootInputs): RoamingBootDecision {
  const state = leaseState(i.lease, i.ownerToken, i.now);
  if (state === "foreignLive" && !i.leaseClaimed) {
    return { action: "blocked", origin: i.lease!.origin, expiresAt: i.lease!.expiresAt };
  }

  // Handoff-proof gate — fail closed. DEFERRED when a backup exists but its version is unreadable
  // (fresh origin: reading it needs the user's secret); the restore flow re-runs the check after
  // decryption (roaming-session.submitSecret). A MISSING backup file is readable evidence (v0), so
  // the gate still fires then.
  if (i.backupStateVersion !== null || !i.backupPresent) {
    const proof = evaluateHandoffProof(i);
    if (!proof.proven) {
      return {
        action: "halt-version-gap",
        staleOrigin: proof.staleOrigin,
        // Diagnostic only, and frequently 0: a holder that died after its last heartbeat advertises
        // exactly what the backup holds, which is the whole point of #90. Never render it as a count.
        missingVersions: Math.max(0, proof.advertisedVersion - Math.max(proof.backupVersion, i.localStateVersion)),
        overridable: true,
      };
    }
  }

  if (!i.localSeedPresent) {
    return i.backupPresent ? { action: "restore-into-empty" } : { action: "setup-needed" };
  }
  return { action: "start" };
}

export type HeartbeatDecision = "renew" | "evicted";

/** What a RUNNING holder should do on its heartbeat tick, having READ the lease first.
 *  A missing/malformed record is renewed (rewritten) — losing the file must not stop the wallet;
 *  a foreign owner (any phase) means another origin claimed the wallet → self-fence. */
export function heartbeatDecision(record: RoamingLeaseRecord | null, ownerToken: string): HeartbeatDecision {
  if (!record) return "renew";
  return record.owner === ownerToken ? "renew" : "evicted";
}

/** True once heartbeat write/read failures have spanned longer than the lease window — from any
 *  other origin's point of view our lease has lapsed and may be legitimately taken over, so the
 *  only safe move is to stop (self-fence). firstFailureAt is null while healthy. */
export function shouldSelfFenceOnOutage(firstFailureAt: number | null, now: number, leaseMs = ROAMING_LEASE_MS): boolean {
  return firstFailureAt !== null && now - firstFailureAt > leaseMs;
}

/** What an unproven predecessor becomes on OUR record. Exported for the lease's sync-close path.
 *  Claiming over someone whose final flush we can't verify snapshots them here; our own renewals
 *  carry the snapshot verbatim; a released predecessor (or none) leaves nothing to carry. */
export function carryPredecessor(
  previous: RoamingLeaseRecord | null,
  ownerToken: string,
  now: number,
): RoamingLeaseRecord["unprovenPredecessor"] {
  if (!previous || previous.phase === "released") return undefined;
  if (previous.owner === ownerToken) return previous.unprovenPredecessor; // our own renewal
  return {
    owner: previous.owner,
    origin: previous.origin,
    advertisedVersion: advertisedVersionOf(previous),
    since: now,
  };
}

/** Build the record a holder writes on acquire/renew. seq increments over whatever was read. */
export function buildLeaseRecord(opts: {
  ownerToken: string;
  origin: string;
  appName?: string;
  now: number;
  previous: RoamingLeaseRecord | null;
  heartbeatStateVersion: number;
  leaseMs?: number;
  /** The override path ONLY: the user declared the predecessor dead and accepted the consequence. */
  clearPredecessor?: boolean;
}): RoamingLeaseRecord {
  const leaseMs = opts.leaseMs ?? ROAMING_LEASE_MS;
  const r: RoamingLeaseRecord = {
    v: 1,
    owner: opts.ownerToken,
    origin: opts.origin,
    acquiredAt: opts.previous?.owner === opts.ownerToken ? opts.previous.acquiredAt : opts.now,
    expiresAt: opts.now + leaseMs,
    seq: (opts.previous?.seq ?? 0) + 1,
    heartbeatStateVersion: opts.heartbeatStateVersion,
    phase: "live",
  };
  if (opts.appName) r.appName = opts.appName;
  const carried = opts.clearPredecessor ? undefined : carryPredecessor(opts.previous, opts.ownerToken, opts.now);
  if (carried) r.unprovenPredecessor = carried;
  return r;
}

/** Whether a takeover claimant may STOP WAITING for the previous holder's handoff — NOT whether it
 *  may restore. `timeout` means "the holder is dead/offline, no ack is coming"; the handoff-proof
 *  gate downstream is the safety decision, and with no ack it halts. Keeping the two separate is
 *  deliberate: folding the halt in here would duplicate it in two places.
 *  `takeoverStartedAt` is when WE wrote our claim.
 *  NOTE: the backup's Drive `modifiedTime` is deliberately NOT consulted. It says nothing about WHO
 *  wrote the file or at WHAT version, so it was never proof — and because the holder uploads before
 *  it acks, believing it raced us into halting on the HAPPY path. The ack is the only proof. */
export function takeoverMayProceed(opts: {
  record: RoamingLeaseRecord | null;
  ourToken: string;
  previousOwner: string;
  takeoverStartedAt: number;
  now: number;
  waitMs?: number;
}): { proceed: boolean; reason: "acked" | "timeout" | "waiting" | "lost" } {
  // Someone else overwrote our claim while we waited → we lost the race, back to blocked.
  if (opts.record && opts.record.owner !== opts.ourToken && opts.record.phase !== "released") {
    return { proceed: false, reason: "lost" };
  }
  if (opts.record?.handoffAck?.from === opts.previousOwner) return { proceed: true, reason: "acked" };
  if (opts.now - opts.takeoverStartedAt >= (opts.waitMs ?? TAKEOVER_WAIT_MS)) {
    return { proceed: true, reason: "timeout" };
  }
  return { proceed: false, reason: "waiting" };
}

/** Parse a lease file's JSON contents defensively; malformed → null (treated as absent). */
export function parseLeaseRecord(raw: string | null): RoamingLeaseRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as RoamingLeaseRecord;
    if (typeof r?.owner === "string" && typeof r?.expiresAt === "number" && (r.phase === "live" || r.phase === "released")) {
      return r;
    }
  } catch {
    /* malformed lease → treat as absent (a fresh acquire rewrites it) */
  }
  return null;
}
