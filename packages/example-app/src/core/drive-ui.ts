// Presentation mapping for the Connect Drive button so its label + color reflect the
// connection state (clearer than the small status-text alone). Pure + dependency-free
// for testing; main.ts applies the result to the button element.

export function driveButtonView(connected: boolean): { label: string; className: string } {
  return connected
    ? { label: "Connected ✓", className: "btn btn-success" }
    : { label: "Connect Drive", className: "btn btn-secondary" };
}
