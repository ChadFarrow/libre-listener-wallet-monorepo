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
  /** The holder's LOCAL state_version at its last heartbeat. THE field that makes a crash-without-
   *  final-flush detectable: a successor comparing this against the backup's version sees the gap. */
  heartbeatStateVersion: number;
  phase: "live" | "released";
  /** Written by an evicted holder after its final flush, WITHOUT changing owner — the claimant
   *  polls for this (or a fresher backup) before restoring. */
  handoffAck?: { from: string; flushedVersion: number; at: number };
}

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
  | { action: "halt-version-gap"; staleOrigin: string; missingVersions: number } // Drive is behind a crashed holder
  | { action: "restore-into-empty" } // no local wallet, backup exists → prompt secret, importState
  | { action: "setup-needed" } // no local wallet, no backup → send the user to the wallet app
  | { action: "start" }; // local wallet present → startNode() (its internal guards do the rest)

export interface RoamingBootInputs {
  /** The lease record AS PEEKED BEFORE CLAIMING — post-claim it's crash-gap evidence only. */
  lease: RoamingLeaseRecord | null;
  ownerToken: string;
  now: number;
  /** True when the caller has ALREADY claimed (written) the lease — the pre-claim record can then
   *  never mean "blocked" (we own the file); it only feeds the crash-gap check. */
  leaseClaimed?: boolean;
  /** Whether a Drive backup file exists for this network, and its state_version if known.
   *  (Version may be null for older backups or when only presence was probed.) */
  backupPresent: boolean;
  backupStateVersion: number | null;
  /** Local storage inspection for this network's wallet DB. */
  localSeedPresent: boolean;
  localStateVersion: number;
}

/**
 * The roaming half of the boot decision. Deliberately does NOT re-implement the local
 * stale/rollback/foreign-backup guards — those already live in the controller's start path
 * (recoverOrHalt / restore-guard / state-version-mirror) and run inside "start". This decides
 * only what roaming adds: the lease gate, the crash-gap check, and empty-vs-populated local.
 */
export function roamingBootDecision(i: RoamingBootInputs): RoamingBootDecision {
  const state = leaseState(i.lease, i.ownerToken, i.now);
  if (state === "foreignLive" && !i.leaseClaimed) {
    return { action: "blocked", origin: i.lease!.origin, expiresAt: i.lease!.expiresAt };
  }

  // Crash-gap check: the last holder advertised (via its heartbeat) a state_version NEWER than
  // what the backup file holds → its final flush never landed. Restoring the backup here would
  // put a stale node on the channel (force-close on reconnect). EXCEPTIONS: (a) if OUR local copy
  // is at (or past) the advertised version, we ARE the origin holding the missing state — proceed;
  // our next flush catches Drive up. (b) If a backup exists but its version is UNREADABLE yet
  // (fresh origin — reading it needs the user's secret), DEFER: the restore flow re-runs this
  // check after decryption (roaming-session.submitSecret). A missing backup file IS readable
  // evidence (version 0), so the check still fires then.
  if (i.lease && i.lease.phase !== "released" && (i.backupStateVersion !== null || !i.backupPresent)) {
    const advertised = i.lease.heartbeatStateVersion || 0;
    const backupVersion = i.backupStateVersion ?? 0;
    if (advertised > backupVersion && i.localStateVersion < advertised) {
      return {
        action: "halt-version-gap",
        staleOrigin: i.lease.origin,
        missingVersions: advertised - Math.max(backupVersion, i.localStateVersion),
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

/** Build the record a holder writes on acquire/renew. seq increments over whatever was read. */
export function buildLeaseRecord(opts: {
  ownerToken: string;
  origin: string;
  appName?: string;
  now: number;
  previous: RoamingLeaseRecord | null;
  heartbeatStateVersion: number;
  leaseMs?: number;
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
  return r;
}

/** Whether a takeover claimant may proceed: the previous holder acked our takeover (its final
 *  flush landed), or the wait timed out (holder dead/offline — the version-gap check is then the
 *  real safety decision). `takeoverStartedAt` is when WE wrote our claim. */
export function takeoverMayProceed(opts: {
  record: RoamingLeaseRecord | null;
  ourToken: string;
  previousOwner: string;
  backupModifiedAfterClaim: boolean;
  takeoverStartedAt: number;
  now: number;
  waitMs?: number;
}): { proceed: boolean; reason: "acked" | "backup-flushed" | "timeout" | "waiting" | "lost" } {
  // Someone else overwrote our claim while we waited → we lost the race, back to blocked.
  if (opts.record && opts.record.owner !== opts.ourToken && opts.record.phase !== "released") {
    return { proceed: false, reason: "lost" };
  }
  if (opts.record?.handoffAck?.from === opts.previousOwner) return { proceed: true, reason: "acked" };
  if (opts.backupModifiedAfterClaim) return { proceed: true, reason: "backup-flushed" };
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
