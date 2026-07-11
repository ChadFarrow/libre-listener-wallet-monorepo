// Presentation mapping for the Connect Drive button so its label + color reflect the
// connection state (clearer than the small status-text alone). Pure + dependency-free
// for testing; main.ts applies the result to the button element.

export function driveButtonView(connected: boolean): { label: string; className: string } {
  return connected
    ? { label: "Connected ✓", className: "btn btn-success" }
    : { label: "Connect Drive", className: "btn btn-secondary" };
}

// Which button is the PRIMARY (green) action on the Cloud-backup screen, and the connect button's
// label. When already connected the primary action is "Back up now" — a big green "Reconnect" read
// as "something's wrong" (it isn't; the token just refreshes), so the connect button drops to a
// quiet secondary labelled "Switch Google account". When disconnected the connect button is the
// primary: "Reconnect" if we remember the account (token dropped), else "Connect Drive". Pure so
// the label/priority logic is unit-tested; the screen maps `primary` → btn-primary else btn-ghost.
export function cloudBackupButtons(
  connected: boolean,
  hasRememberedAccount: boolean,
): { connect: { label: string; primary: boolean }; backupNowPrimary: boolean } {
  if (connected) {
    return { connect: { label: "Switch Google account", primary: false }, backupNowPrimary: true };
  }
  return { connect: { label: hasRememberedAccount ? "Reconnect" : "Connect Drive", primary: true }, backupNowPrimary: false };
}

// The little status chip next to "Cloud backup" in the drawer, so the connected/syncing state is
// visible at a glance without opening the screen. "configured" = a remembered Drive account (set up),
// "connected" = a live token this session, "running" = node up (auto-sync only fires while running).
export function drawerBackupStatus(opts: {
  demo: boolean;
  configured: boolean;
  connected: boolean;
  running: boolean;
}): { label: string; cls: string } {
  if (opts.demo) return { label: opts.configured ? "Demo" : "", cls: "" };
  if (!opts.configured) return { label: "Off", cls: "warn" };
  if (opts.connected && opts.running) return { label: "Syncing ✓", cls: "ok" };
  return { label: "Connected", cls: "ok" };
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
