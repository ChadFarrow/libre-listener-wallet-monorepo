// Boot-time DOM copy adjustments for the native Android APK, gathered in one place (and testable) so
// the app's native wording lives together instead of scattered through main.ts. The static index.html
// ships browser-PWA copy that's accurate there; in the Capacitor wrapper a few labels are wrong or a
// section is dead, so we rewrite/remove them once at boot. Behavioral native adaptations (keep-alive
// default-on, the overlay-permission prompt) stay in main.ts — this is copy only.
//
// The caller passes the platform flags so the function is pure w.r.t. platform detection and easy to
// drive from jsdom. All operations are individually guarded — a renamed element is a silent no-op,
// never a throw.

export function applyNativeUiCopy(opts: { native: boolean; localBackup: boolean }): void {
  const { native, localBackup } = opts;

  // Backup is a local/SAF folder in the APK, not the cloud — relabel the drawer item + backup screen.
  if (localBackup) {
    const drawerLabel = document.querySelector("#d-backup .grow");
    if (drawerLabel) drawerLabel.textContent = "Local backup";
    const backupTitle = document.querySelector("#screen-backup .title");
    if (backupTitle) backupTitle.textContent = "Local backup";
  }

  if (!native) return;

  // Keep-alive is a foreground service on Android, not "iOS background audio" — relabel the control.
  const kaDetails = document.getElementById("keepalive-toggle")?.closest("details");
  if (kaDetails) {
    const summary = kaDetails.querySelector("summary");
    if (summary) summary.textContent = "Background mode";
    const note = kaDetails.querySelector(".center-note");
    if (note)
      note.textContent =
        "Keeps the node running in the background so boosts settle while the app is in the background.";
    const label = document.getElementById("keepalive-toggle")?.parentElement;
    if (label?.lastChild) label.lastChild.textContent = " Keep the node running in the background";
  }

  // Web Push (offline wake) can't work in the APK (no FCM on GrapheneOS; the foreground service
  // replaces it) — remove the whole section so it isn't a dead toggle.
  document.getElementById("push-enable")?.closest("details")?.remove();
}
