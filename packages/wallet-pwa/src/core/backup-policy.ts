// Which backup channel runs. Google Drive, once configured, REPLACES the local auto-download
// (a dated file every state change is redundant next to Drive sync and spams Downloads under
// payment traffic); and mobile never auto-downloads at all — silent repeated downloads are
// hostile or broken in mobile browsers, so Drive is the only backup channel there. Pure so the
// policy is unit-testable; callers pass the live inputs.

export function isMobileUa(ua: string): boolean {
  return /Android|iPhone|iPad|iPod/i.test(ua || "");
}

export function shouldAutoDownload(opts: {
  toggleOn: boolean;
  driveConfigured: boolean;
  mobile: boolean;
}): boolean {
  return opts.toggleOn && !opts.driveConfigured && !opts.mobile;
}

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

// A transient IndexedDB failure seen when the debounced auto-backup's export STRADDLES a node restart
// (an iOS OAuth-redirect return, a forced-restore, an auto-start): the storage layer is being reopened
// while exportState() reads its keys, so a read lands on a transaction that's already closed —
// "Attempt to get a record from database without an in-progress transaction". This is NOT a real
// backup failure (the next state-change re-arms a fresh sync), so the caller retries once quietly and
// only warns if it's still failing. Pure + here so the classification is unit-tested.
export function isTransientBackupStorageError(message: string): boolean {
  const m = (message || "").toLowerCase();
  return (
    m.includes("in-progress transaction") ||
    m.includes("transaction is not active") ||
    m.includes("transaction has finished") ||
    m.includes("the database connection is closing") ||
    m.includes("database is not open")
  );
}
