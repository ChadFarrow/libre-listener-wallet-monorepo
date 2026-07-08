// Cross-DEVICE single-instance guard. The Web-Locks single-node lock only covers one browser
// origin; it can't see the same wallet (seed) running on a phone + a laptop at once — two live nodes
// on one channel diverge state and force-close. This lease closes that gap using the shared VSS store
// (every device with the same seed derives the same store) as the coordination point: a device claims
// a time-boxed lease at startup via a compare-and-swap write; a second device that sees a live lease
// refuses to start. Reliability-first: on a VSS outage the caller starts with a warning (advisory),
// and a crashed holder's lease auto-expires so another device can take over. Pure decision here; the
// VSS I/O lives in the SDK's vss-device-lease.ts.

import { errorMatchesCode } from "./error-code";

export const SINGLE_DEVICE_VIOLATION_CODE = "SINGLE_DEVICE_VIOLATION";

/** Default lease length + renewal cadence. A holder renews well within the lease; if it crashes, the
 *  lease lapses after DEVICE_LEASE_MS so another device can claim the wallet (the 2-min takeover window). */
export const DEVICE_LEASE_MS = 120_000;
export const DEVICE_LEASE_RENEW_MS = 40_000;

export interface DeviceLeaseRecord {
  owner: string; // random per-process id of the device currently holding the wallet
  acquiredAt: number; // epoch ms
  expiresAt: number; // epoch ms after which the lease is stale and claimable by another device
}

export type LeaseDecision = "acquire" | "renew" | "blocked";

/**
 * Decide what a starting device should do given the lease currently in the shared store.
 * - no record, or an EXPIRED one → "acquire" (free / crashed holder → take over)
 * - the record is OURS → "renew" (a restart of the same device)
 * - a DIFFERENT device holds a still-live lease → "blocked" (refuse to start)
 * Pure + now-injectable so it's unit-testable without a clock or VSS.
 */
export function evaluateDeviceLease(
  existing: DeviceLeaseRecord | null | undefined,
  ownerId: string,
  now: number,
): LeaseDecision {
  if (!existing) return "acquire";
  if (existing.owner === ownerId) return "renew";
  if (now >= existing.expiresAt) return "acquire";
  return "blocked";
}

/** Boundary-stable check (mirrors isNodeAlreadyRunningError): true for the cross-device lock error,
 *  matching on the `code` field or the code token in `.message` (survives error-flattening). */
export function isCrossDeviceLockError(e: unknown): boolean {
  return errorMatchesCode(e, SINGLE_DEVICE_VIOLATION_CODE);
}
