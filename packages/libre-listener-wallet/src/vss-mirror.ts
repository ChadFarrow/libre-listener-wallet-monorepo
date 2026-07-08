// Best-effort, debounced mirror of the encrypted backup envelope to VSS as a durable, authoritative
// off-device replica (Design A — the same way LDK-node and Mutiny actually use VSS). It NEVER throws
// into the caller and NEVER gates LDK state advancement: local IndexedDB stays the source of truth;
// VSS is the copy the node re-hydrates from at start() when local storage was lost/reaped/stale —
// the dominant browser force-close cause. Uses a blind write (version -1) exactly like LDK's own
// VssStore, since a wallet is the single writer of its own state.
//
// The value we store is the existing slim, seed-encrypted backup envelope (exportState) — no new
// crypto and no storage-contract change: the server only ever sees the same ciphertext the Drive
// backup already produces (key-isolation guardrail holds).
import type { VssClient, VssLogger } from "./vss-client";
import { bytesToHex } from "./storage-cache";

export const VSS_STATE_BACKUP_KEY = "state_backup";
const VSS_BLIND_WRITE_VERSION = -1;
const DEFAULT_DEBOUNCE_MS = 5000;

// Structural type so tests can inject a stub without a full VssClient.
export type VssMirrorTarget = Pick<VssClient, "putObjects">;

// Derive a stable, per-wallet VSS store id from the seed WITHOUT exposing it: SHA-256 of a labelled
// seed, hex. Same seed → same id across restarts; different wallets never collide on one version line.
export async function deriveVssStoreId(seedHex: string): Promise<string> {
  const data = new TextEncoder().encode(`libre-vss-store-v1:${seedHex}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

export class VssMirror {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;
  private pendingWhileInFlight = false;
  private stopped = false;
  private debounceMs: number;
  private logger?: VssLogger;

  constructor(
    private client: VssMirrorTarget,
    private exportEnvelope: () => Promise<string>,
    opts: { debounceMs?: number; logger?: VssLogger } = {},
  ) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.logger = opts.logger;
  }

  // Request a mirror. This is a THROTTLE, not a resetting debounce: if an upload is already
  // scheduled we leave it (it will capture the latest state when it fires) instead of pushing it
  // out. A resetting debounce is fatal for an always-active wallet — the event tick fires a state
  // change roughly every second during/after payments, so the timer never elapses and VSS is NEVER
  // updated (it stays stuck at the empty start state → a re-hydrating device restores an empty
  // channel → force-close). With the throttle, VSS is refreshed to the latest state every debounceMs.
  schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, this.debounceMs);
  }

  /**
   * Force an immediate upload of the CURRENT state and await it. Called on a clean stop() so the
   * device that picks up the wallet next (via VSS re-hydrate) gets this device's FINAL state, not a
   * throttled-stale one — the core of a safe cross-device handoff. Best-effort + non-throwing.
   */
  async flush(): Promise<void> {
    if (this.stopped) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.upload();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private async run(): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) {
      // An upload is in progress; re-run once it finishes so we don't drop the latest state.
      this.pendingWhileInFlight = true;
      return;
    }
    await this.upload();
    if (this.pendingWhileInFlight && !this.stopped) {
      this.pendingWhileInFlight = false;
      this.schedule();
    }
  }

  // The actual exportState → putObjects, guarded by inFlight so concurrent callers coalesce.
  private async upload(): Promise<void> {
    this.inFlight = true;
    try {
      const envelope = await this.exportEnvelope();
      const value = new TextEncoder().encode(envelope);
      await this.client.putObjects([
        { key: VSS_STATE_BACKUP_KEY, version: VSS_BLIND_WRITE_VERSION, value },
      ]);
      this.logger?.info?.(`[VSS] Mirrored state backup (${value.length} bytes)`);
    } catch (e) {
      // Best-effort: a VSS outage must never disturb the wallet.
      this.logger?.warn?.(`[VSS] Mirror failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.inFlight = false;
    }
  }
}
