// Offline rollback detector — a second, always-local witness of the wallet's monotonic state_version.
//
// The BACKUP_AHEAD guard (backup-ahead.ts) can only notice an iOS storage rollback by comparing local
// against the OFF-DEVICE backup — and on an installed iOS PWA that backup is unreachable at the exact
// moment auto-start fires (the silent Drive reconnect popup is blocked, so Drive only connects later
// via the full-page redirect). So the node boots on stale state before the guard can ever see it.
//
// This mirror closes that hole without any network: the SDK's `state_version` (a per-wallet counter
// that only ever ++), which lives in the per-network IndexedDB, is copied into a SEPARATE store
// (localStorage — a different WebKit storage backend that iOS may evict independently). It is kept as
// a HIGH-WATER mark: it never decreases, so a rolled-back read can't quietly lower it. At start, if
// the mirror is strictly ahead of the on-disk `state_version`, the per-network DB was rolled back to
// an older self-consistent snapshot underneath us → halt and force a restore, offline and instantly.
//
// Scope: this catches a PARTIAL rollback (IndexedDB evicted while localStorage survives). A whole-
// origin wipe clears the mirror too — that case is covered by the auto-start deferral (refuse to
// auto-start a Drive-configured wallet whose freshness can't be verified). The two layers compose.

export const STATE_ROLLBACK_CODE = "STATE_ROLLBACK";

// localStorage key holding the high-water state_version mirror for a network. Kept per-network to
// mirror the per-network IndexedDB (each network is an independent wallet).
export function mirrorKeyForNetwork(network: string): string {
  return `libre_state_version_hwm:${network || "mainnet"}`;
}

// Coerce a raw stored value (number, decimal string, null) to a safe non-negative integer; anything
// unparseable / NaN / negative reads as 0.
function coerce(v: number | string | null | undefined): number {
  const n = typeof v === "string" ? parseInt(v, 10) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// The high-water value to persist next: never below the existing mirror, so a stale/partial read of
// the on-disk counter can't lower the witness (which would let a later real rollback slip through).
export function nextMirrorValue(current: number | string | null, mirror: number | string | null): number {
  return Math.max(coerce(current), coerce(mirror));
}

// True when the mirror proves the on-disk state_version regressed (mirror strictly ahead of local).
// Equal or behind is fine — a current wallet, or a mirror that itself was cleared/rolled back (which
// simply re-seeds; it never force-halts a healthy on-disk state).
export function localStateRolledBack(
  localVersion: number | string | null,
  mirrorVersion: number | string | null,
): boolean {
  return coerce(mirrorVersion) > coerce(localVersion);
}

// Thrown from the start path when the offline mirror shows local storage rolled back. Carries a
// boundary-stable `code` mirrored into `.message` (same convention as BackupAheadError /
// ChannelStateRegressionError) so it survives error flattening.
export class StateRollbackError extends Error {
  readonly code = STATE_ROLLBACK_CODE;
  constructor(readonly localVersion: number, readonly mirrorVersion: number) {
    super(
      `This device's wallet storage was rolled back (on-disk v${localVersion} is behind this device's ` +
        `own record v${mirrorVersion}). Starting now would force-close your channel. Restore from your ` +
        `backup to continue. [${STATE_ROLLBACK_CODE}]`,
    );
    this.name = "StateRollbackError";
  }
}

export function isStateRollbackError(e: unknown): boolean {
  if ((e as { code?: string })?.code === STATE_ROLLBACK_CODE) return true;
  const msg = (e as { message?: string })?.message;
  return typeof msg === "string" && msg.includes(`[${STATE_ROLLBACK_CODE}]`);
}

// User-facing copy for the forced restore screen (no raw code / version numbers leak into the UI —
// same treatment as the channel-regression and backup-ahead messages).
export const STATE_ROLLBACK_MSG =
  "This device's wallet storage was rolled back. Starting now would force-close your channel. " +
  "Restore from your backup to continue.";
