// Backup-ahead start guard.
//
// The channel-state-regression halt (SDK) compares a loaded monitor's update-id against a LOCAL
// high-water mark. It cannot catch the case where iOS evicts the WHOLE IndexedDB and the wallet
// reloads from an OLDER but internally self-consistent snapshot (monitors + high-water rolled back
// together) — locally nothing looks wrong, yet the channel's real state is ahead of what this
// device holds, and starting + reconnecting force-closes the channel (LDK "we have fallen behind").
//
// The only reference that survives local eviction is the off-device backup. This module is the pure
// decision layer: given the local `state_version` and the (decrypted) backup's `state_version`,
// decide whether the backup is AHEAD — i.e. local storage regressed and must be restored, not run.
//
// `state_version` is a monotonic per-wallet counter (only ever ++), persisted locally AND carried in
// the backup, so both values come from the same sequence — a sound "backup is newer" signal without
// decoding any LDK monitor.

export const BACKUP_AHEAD_CODE = "BACKUP_AHEAD";

/**
 * True when the backup's state_version is strictly greater than local — meaning local storage is a
 * stale snapshot and starting now risks a force-close. Equal or behind is fine (a normal, current,
 * or slightly-behind-backup wallet). Both are coerced to safe integers; a NaN/negative reads as 0.
 */
export function backupAheadOfLocal(localVersion: number, backupVersion: number): boolean {
  const local = Number.isFinite(localVersion) && localVersion > 0 ? Math.floor(localVersion) : 0;
  const backup = Number.isFinite(backupVersion) && backupVersion > 0 ? Math.floor(backupVersion) : 0;
  return backup > local;
}

// Thrown from the start path when the cloud backup is ahead of local storage. Carries a boundary-
// stable `code` mirrored into `.message` so it survives error flattening, mirroring the SDK's
// ChannelStateRegressionError / DriveForeignBackupError convention.
export class BackupAheadError extends Error {
  readonly code = BACKUP_AHEAD_CODE;
  constructor(readonly localVersion: number, readonly backupVersion: number) {
    super(
      `Your cloud backup is newer than this device's wallet data (backup v${backupVersion} vs local ` +
        `v${localVersion}). This device's storage was rolled back — starting now would force-close your ` +
        `channel. Restore from your backup to continue. [${BACKUP_AHEAD_CODE}]`,
    );
    this.name = "BackupAheadError";
  }
}

export function isBackupAheadError(e: unknown): boolean {
  if ((e as { code?: string })?.code === BACKUP_AHEAD_CODE) return true;
  const msg = (e as { message?: string })?.message;
  return typeof msg === "string" && msg.includes(`[${BACKUP_AHEAD_CODE}]`);
}

// User-facing copy for the forced restore screen (no raw code / version numbers leak into the UI —
// same treatment as the channel-regression message).
export const BACKUP_AHEAD_MSG =
  "Your cloud backup is newer than this device's wallet data — this device was rolled back. " +
  "Starting now would force-close your channel. Restore from your backup to continue.";
