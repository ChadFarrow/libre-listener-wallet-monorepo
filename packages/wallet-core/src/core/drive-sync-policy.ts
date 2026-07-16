// When the Drive backup gets refreshed. Shared by EVERY host that runs a node (the wallet PWA and
// the embeddable widget), because how far Drive lags local state is a fund-safety property, not a
// UI preference: a successor origin can only take the wallet over safely if the backup actually
// holds what this origin last did.
//
// It lives here rather than in one app because the embed originally had NO auto-sync at all — its
// backup sat frozen at the roam-in version for a whole session, and the takeover that followed
// restored a 9-commitments-stale backup onto a live mainnet channel and force-closed it (#90). The
// PWA had the policy the whole time. This is the #76 lesson applied before the copies happen: a
// second hand-maintained copy of a fund-safety predicate is how the next one-sided fix gets missed.

/** The debounce between a state change and the upload. Long enough to coalesce a burst of payment
 *  state, short enough that the un-flushed window stays small (that window is the one residual
 *  crash gap the handoff-proof gate can only halt on, never undo). */
export const DRIVE_SYNC_DEBOUNCE_MS = 5_000;

// Whether a controller event should (re)schedule the debounced Google Drive backup. This is what
// keeps backups — and therefore restores — hands-off: EVERY app path that dials a peer emits a
// "state-changed" (controller.connectPeer + the restore/auto-start peer dial), so a newly-learned
// peer address is pushed to Drive within the debounce, no manual "Back up now". The backup only
// runs while the node is up (exportState needs it) and Drive has a live token; demo never touches
// Drive. Pure so the hands-off guarantee is unit-tested, not just implied by the wiring.
export function shouldDriveAutoSync(opts: {
  event: string;
  demo: boolean;
  running: boolean;
  driveConnected: boolean;
}): boolean {
  return opts.event === "state-changed" && !opts.demo && opts.running && opts.driveConnected;
}
