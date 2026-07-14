// Preconditions for restoring an encrypted backup into a network's IndexedDB.
//
// Restoring builds a fresh wallet and imports channel state into a network DB. Two hazards it must
// refuse (both are force-close / fund-loss class):
//   1. A node is already running — importing under a live node lets the running node's next state
//      flush overwrite the just-restored channel_manager (seed-without-matching-state → force-close
//      on channel_reestablish), and leaks the old node's timers/sockets.
//   2. The target network DB already holds channel state — restoring a stale backup over a funded
//      wallet would overwrite live channel state.
// Also serialized against itself (a double-click firing two concurrent restores races the same DB).
// Pure and dependency-free so it is unit-testable without LDK/WASM.
//
// EXCEPTION to hazard #2 — the backup-ahead recovery: when this device's storage was rolled back
// (iOS eviction) the local channel state is the STALE copy and the off-device backup is NEWER. In
// that case the `channel_manager` on disk is exactly what must be overwritten — blocking the restore
// leaves the user stuck (start() refuses with BACKUP_AHEAD, restore refuses with "funded wallet
// exists"). `mayOverwriteStaleLocal` narrowly re-permits the overwrite ONLY when the backup is
// provably the same wallet (decrypts with the LOCAL seed) AND its state_version is strictly ahead of
// local — the exact mirror of the start-path BACKUP_AHEAD guard. A stale/foreign backup can never
// clobber a funded wallet.

import { backupAheadOfLocal } from "./backup-ahead";

export const RESTORE_RUNNING_MSG = "Stop the node before restoring from a backup.";
export const RESTORE_IN_PROGRESS_MSG = "A restore is already in progress.";
export const RESTORE_FUNDED_MSG = "A funded wallet already exists on this network. Restoring would overwrite it.";

export interface RestoreState {
  running: boolean;
  restoring: boolean;
  targetHasChannelState: boolean;
}

// Returns the blocking reason (a user-facing message) or null when the restore is allowed.
export function restoreBlockReason(state: RestoreState): string | null {
  if (state.running) return RESTORE_RUNNING_MSG;
  if (state.restoring) return RESTORE_IN_PROGRESS_MSG;
  if (state.targetHasChannelState) return RESTORE_FUNDED_MSG;
  return null;
}

export interface StaleOverwriteInput {
  // Does the target network DB already hold channel state? (Only then is an overwrite in question.)
  hasLocalChannelState: boolean;
  // Did the backup decrypt with the LOCAL seed — i.e. is it the SAME wallet as the stale local state?
  backupDecryptsWithLocalSeed: boolean;
  // Local `state_version` (0 when absent/unparseable) and the backup's (null when unknown).
  localStateVersion: number;
  backupStateVersion: number | null;
}

// True when existing local channel state may be safely OVERWRITTEN by the restore because the backup
// demonstrably supersedes it (same wallet + strictly-newer state_version = the rolled-back-device
// BACKUP_AHEAD case). Any doubt — different wallet, unknown/equal/older version — returns false so
// the funded-wallet guard stays fully protective.
export function mayOverwriteStaleLocal(i: StaleOverwriteInput): boolean {
  if (!i.hasLocalChannelState) return false;
  if (!i.backupDecryptsWithLocalSeed) return false;
  if (i.backupStateVersion == null) return false;
  return backupAheadOfLocal(i.localStateVersion, i.backupStateVersion);
}
