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
