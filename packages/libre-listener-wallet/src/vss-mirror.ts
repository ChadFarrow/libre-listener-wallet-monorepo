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
import type { VssClient } from "./vss-client";

export const VSS_STATE_BACKUP_KEY = "state_backup";
const VSS_BLIND_WRITE_VERSION = -1;
const DEFAULT_DEBOUNCE_MS = 5000;

export interface VssMirrorLogger {
  info?: (m: string) => void;
  warn?: (m: string) => void;
  error?: (m: string) => void;
}

// Structural type so tests can inject a stub without a full VssClient.
export type VssMirrorTarget = Pick<VssClient, "putObjects">;

// Derive a stable, per-wallet VSS store id from the seed WITHOUT exposing it: SHA-256 of a labelled
// seed, hex. Same seed → same id across restarts; different wallets never collide on one version line.
export async function deriveVssStoreId(seedHex: string): Promise<string> {
  const data = new TextEncoder().encode(`libre-vss-store-v1:${seedHex}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class VssMirror {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;
  private pendingWhileInFlight = false;
  private stopped = false;
  private debounceMs: number;
  private logger?: VssMirrorLogger;

  constructor(
    private client: VssMirrorTarget,
    private exportEnvelope: () => Promise<string>,
    opts: { debounceMs?: number; logger?: VssMirrorLogger } = {},
  ) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.logger = opts.logger;
  }

  // Request a mirror; coalesces a burst of state changes within debounceMs into a single upload.
  schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, this.debounceMs);
  }

  // Mirror immediately (used once at start so VSS holds the current state without waiting for the
  // next change). Still best-effort + non-throwing.
  flushNow(): void {
    if (this.stopped) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    void this.run();
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
      if (this.pendingWhileInFlight && !this.stopped) {
        this.pendingWhileInFlight = false;
        this.schedule();
      }
    }
  }
}
