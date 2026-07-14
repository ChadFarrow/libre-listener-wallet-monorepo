import type { WalletController } from "../wallet-controller";
import { isChannelStateRegressionError, isNodeAlreadyRunningError } from "@libre/shared";
import { isBackupAheadError, BACKUP_AHEAD_MSG } from "../core/backup-ahead";
import { isStateRollbackError, STATE_ROLLBACK_MSG } from "../core/state-version-mirror";
import { forceRestoreScreen, clearRestoreLatch } from "./restore";

export const NODE_ALREADY_RUNNING_MSG =
  "This wallet is already running in another tab or window — close it and try again.";

// Start the node with the full fund-safety error routing shared by every "Start" surface (the Node
// screen's button AND the home status pill's tap-to-start). A channel-state regression / backup-ahead
// / state-rollback error MUST route to the forced-restore screen — starting on stale state would
// force-close the channel — and never surface as a raw error/code. Returns true iff the node started.
export async function startNodeWithGuards(
  controller: WalletController,
  onStatus: (msg: string, level?: "ok" | "err") => void,
): Promise<boolean> {
  onStatus("Starting node…");
  try {
    await controller.startNode();
    clearRestoreLatch();
    onStatus("Node started", "ok");
    return true;
  } catch (e) {
    if (isChannelStateRegressionError(e)) {
      onStatus("");
      forceRestoreScreen();
      return false;
    }
    // The cloud backup is newer than local storage (this device was rolled back / iOS-evicted) —
    // starting would force-close. Route to the same forced-restore screen with the reason.
    if (isBackupAheadError(e)) {
      onStatus("");
      forceRestoreScreen(BACKUP_AHEAD_MSG);
      return false;
    }
    // The offline mirror shows this device's storage was rolled back (iOS partial eviction) — same
    // remedy: restore from backup rather than start on stale state.
    if (isStateRollbackError(e)) {
      onStatus("");
      forceRestoreScreen(STATE_ROLLBACK_MSG);
      return false;
    }
    if (isNodeAlreadyRunningError(e)) {
      onStatus(NODE_ALREADY_RUNNING_MSG, "err");
      return false;
    }
    onStatus((e as Error).message, "err");
    return false;
  }
}
