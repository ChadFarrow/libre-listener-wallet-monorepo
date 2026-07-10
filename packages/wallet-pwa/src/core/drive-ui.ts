// Presentation mapping for the Connect Drive button so its label + color reflect the
// connection state (clearer than the small status-text alone). Pure + dependency-free
// for testing; main.ts applies the result to the button element.

export function driveButtonView(connected: boolean): { label: string; className: string } {
  return connected
    ? { label: "Connected ✓", className: "btn btn-success" }
    : { label: "Connect Drive", className: "btn btn-secondary" };
}

/**
 * Whether to retry a silent Drive reconnect on the user's first interaction. GIS's
 * OAuth token model needs a user gesture (a page-load attempt fails with
 * popup_failed_to_open), so we retry on first gesture — but only when we're
 * disconnected AND have a remembered account (hint) to reconnect silently.
 */
export function shouldArmGestureReconnect(connected: boolean, hint: string | null): boolean {
  return !connected && !!hint;
}

export const NODE_STOPPED_BACKUP_MSG = "Start the node to export or sync a backup.";

/**
 * What the backup card's message line should become on a node state change.
 * Returns the new text, or null to leave the current message untouched.
 *
 * Settings renders before the async auto-start finishes, so the stopped hint gets
 * written at init and must be cleared once the node is up — but ONLY the stopped
 * hint: state-changed fires on every channel-state persist, so clearing
 * unconditionally would wipe a real status (e.g. the export-success message).
 */
export function backupMsgOnStateChange(running: boolean, currentMsg: string): string | null {
  if (!running) return NODE_STOPPED_BACKUP_MSG;
  return currentMsg === NODE_STOPPED_BACKUP_MSG ? "" : null;
}
