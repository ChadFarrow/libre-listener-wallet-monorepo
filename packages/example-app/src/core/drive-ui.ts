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
