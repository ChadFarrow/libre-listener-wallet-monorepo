import type { VssClient } from "./vss-client";
import { isVssConflict } from "./vss-client";
import {
  DEVICE_LEASE_MS,
  DEVICE_LEASE_RENEW_MS,
  evaluateDeviceLease,
  type DeviceLeaseRecord,
} from "@libre/shared";
import { CrossDeviceLockError } from "./cross-device-lease-error";

// Storage key for the cross-device lease inside the (per-seed) VSS store.
export const VSS_DEVICE_LEASE_KEY = "node_lease";

interface LeaseLogger {
  info?: (m: string) => void;
  warn?: (m: string) => void;
  error?: (m: string) => void;
}

// The subset of VssClient the lease needs — lets tests inject a stub over the in-memory VSS server.
export type LeaseVssTarget = Pick<VssClient, "getObject" | "putObjects" | "deleteObject">;

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * VSS-backed cross-device single-instance lease. `acquire()` claims (or takes over an expired) lease
 * via a compare-and-swap write, throwing CrossDeviceLockError if another device holds a live one.
 * `startHeartbeat()` renews it while running (best-effort — a VSS blip never kills the session, which
 * would drop channels). `release()` frees it on stop so another device can switch in immediately.
 */
export class VssDeviceLease {
  private version = 0; // last-known VSS version of the lease key (for the next CAS write)
  private renewTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private readonly leaseMs: number;
  private readonly renewMs: number;
  private readonly now: () => number;
  private readonly logger?: LeaseLogger;

  constructor(
    private client: LeaseVssTarget,
    private ownerId: string,
    opts: { leaseMs?: number; renewMs?: number; now?: () => number; logger?: LeaseLogger } = {},
  ) {
    this.leaseMs = opts.leaseMs ?? DEVICE_LEASE_MS;
    this.renewMs = opts.renewMs ?? DEVICE_LEASE_RENEW_MS;
    this.now = opts.now ?? (() => Date.now());
    this.logger = opts.logger;
  }

  private record(): Uint8Array {
    const now = this.now();
    const r: DeviceLeaseRecord = { owner: this.ownerId, acquiredAt: now, expiresAt: now + this.leaseMs };
    return enc.encode(JSON.stringify(r));
  }

  private parse(value: Uint8Array): DeviceLeaseRecord | null {
    try {
      const r = JSON.parse(dec.decode(value)) as DeviceLeaseRecord;
      if (typeof r?.owner === "string" && typeof r?.expiresAt === "number") return r;
    } catch { /* malformed lease → treat as absent */ }
    return null;
  }

  /**
   * Acquire (or take over an expired) lease. Throws CrossDeviceLockError if another device holds a
   * LIVE lease. On a VSS TRANSPORT failure it returns `{ ok:false, degraded:true }` WITHOUT throwing —
   * the caller then starts with a warning (reliability over the narrow "VSS down AND another device
   * live at this instant" risk). Returns `{ ok:true }` when the lease is held by us.
   */
  async acquire(): Promise<{ ok: boolean; degraded: boolean }> {
    let existing: DeviceLeaseRecord | null;
    let curVersion: number;
    try {
      const obj = await this.client.getObject(VSS_DEVICE_LEASE_KEY);
      curVersion = obj?.version ?? 0;
      existing = obj ? this.parse(obj.value) : null;
    } catch (e) {
      this.logger?.warn?.(
        `[DeviceLease] Could not reach VSS to check for another device (${e instanceof Error ? e.message : String(e)}); starting anyway.`,
      );
      return { ok: false, degraded: true };
    }

    const decision = evaluateDeviceLease(existing, this.ownerId, this.now());
    if (decision === "blocked") {
      throw new CrossDeviceLockError(`held until ${new Date(existing!.expiresAt).toISOString()}`);
    }

    try {
      await this.client.putObjects([{ key: VSS_DEVICE_LEASE_KEY, version: curVersion, value: this.record() }]);
      this.version = curVersion + 1; // server stores version+1 on success
      this.logger?.info?.(`[DeviceLease] Acquired the single-device lease (${decision}).`);
      return { ok: true, degraded: false };
    } catch (e) {
      if (isVssConflict(e)) {
        // Another device claimed the lease between our read and write → it wins; we must not run.
        throw new CrossDeviceLockError("another device claimed the wallet at the same moment");
      }
      this.logger?.warn?.(
        `[DeviceLease] Could not write the lease (${e instanceof Error ? e.message : String(e)}); starting anyway.`,
      );
      return { ok: false, degraded: true };
    }
  }

  /** Begin renewing the lease so it never lapses while this device runs. Best-effort. */
  startHeartbeat(): void {
    if (this.stopped || this.renewTimer) return;
    this.renewTimer = setInterval(() => { void this.renew(); }, this.renewMs);
  }

  private async renew(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.client.putObjects([{ key: VSS_DEVICE_LEASE_KEY, version: this.version, value: this.record() }]);
      this.version++;
    } catch (e) {
      if (isVssConflict(e)) {
        // Someone else wrote the lease key while we hold it — a possible split-brain (two live
        // devices). We can't safely kill our own running node (that drops channels), so log LOUDLY
        // and resync our version so renews keep working. The startup check is the real guard.
        this.logger?.error?.(
          "[DeviceLease] Lease version conflict during renewal — another device may be running the SAME wallet. Close all but one device.",
        );
        try {
          const obj = await this.client.getObject(VSS_DEVICE_LEASE_KEY);
          this.version = (obj?.version ?? this.version) + 1;
        } catch { /* transient — try again next tick */ }
      } else {
        // Transient VSS blip — keep running; retry on the next tick.
        this.logger?.warn?.(`[DeviceLease] Lease renewal failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Release the lease on a clean stop so another device can take over without waiting for expiry. */
  async release(): Promise<void> {
    this.stopped = true;
    if (this.renewTimer) { clearInterval(this.renewTimer); this.renewTimer = undefined; }
    try {
      await this.client.deleteObject({ key: VSS_DEVICE_LEASE_KEY, version: this.version, value: new Uint8Array() });
    } catch (e) {
      this.logger?.warn?.(`[DeviceLease] Lease release failed (non-fatal; it will expire): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
