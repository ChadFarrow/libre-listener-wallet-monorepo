import { describe, it, expect } from "vitest";
import { isMobileUa, shouldAutoDownload, shouldDriveAutoSync, isTransientBackupStorageError } from "./backup-policy";

describe("isMobileUa", () => {
  it("detects phones and tablets", () => {
    expect(isMobileUa("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15")).toBe(true);
    expect(isMobileUa("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36")).toBe(true);
    expect(isMobileUa("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe(true);
  });

  it("treats desktop UAs (and empty) as not mobile", () => {
    expect(isMobileUa("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")).toBe(false);
    expect(isMobileUa("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(false);
    expect(isMobileUa("")).toBe(false);
  });
});

describe("shouldAutoDownload", () => {
  it("runs only on desktop, with the toggle on, and Drive NOT configured", () => {
    expect(shouldAutoDownload({ toggleOn: true, driveConfigured: false, mobile: false })).toBe(true);
  });

  it("Drive configured wins over the toggle (Drive replaces local downloads)", () => {
    expect(shouldAutoDownload({ toggleOn: true, driveConfigured: true, mobile: false })).toBe(false);
  });

  it("never auto-downloads on mobile (Drive is the only backup channel there)", () => {
    expect(shouldAutoDownload({ toggleOn: true, driveConfigured: false, mobile: true })).toBe(false);
    expect(shouldAutoDownload({ toggleOn: true, driveConfigured: true, mobile: true })).toBe(false);
  });

  it("off toggle means off", () => {
    expect(shouldAutoDownload({ toggleOn: false, driveConfigured: false, mobile: false })).toBe(false);
  });
});

describe("shouldDriveAutoSync", () => {
  const base = { event: "state-changed", demo: false, running: true, driveConnected: true };

  it("syncs on a state-changed while running with Drive connected (the peer-connect → backup path)", () => {
    expect(shouldDriveAutoSync(base)).toBe(true);
  });

  it("ignores non state-changed events", () => {
    expect(shouldDriveAutoSync({ ...base, event: "payment" })).toBe(false);
  });

  it("never syncs in demo (must not touch Drive)", () => {
    expect(shouldDriveAutoSync({ ...base, demo: true })).toBe(false);
  });

  it("skips when the node is stopped (exportState needs it) or Drive has no live token", () => {
    expect(shouldDriveAutoSync({ ...base, running: false })).toBe(false);
    expect(shouldDriveAutoSync({ ...base, driveConnected: false })).toBe(false);
  });
});

describe("isTransientBackupStorageError", () => {
  it("flags the IndexedDB transaction races an auto-backup hits when it straddles a node restart", () => {
    // The exact message seen live 2026-07-15.
    expect(
      isTransientBackupStorageError("Attempt to get a record from database without an in-progress transaction"),
    ).toBe(true);
    expect(isTransientBackupStorageError("The transaction is not active.")).toBe(true);
    expect(isTransientBackupStorageError("The transaction has finished.")).toBe(true);
    expect(isTransientBackupStorageError("The database connection is closing.")).toBe(true);
    expect(isTransientBackupStorageError("The database is not open")).toBe(true);
  });

  it("does NOT flag real backup failures (network / auth / foreign-backup) as transient", () => {
    expect(isTransientBackupStorageError("Load failed")).toBe(false);
    expect(isTransientBackupStorageError("Google Drive session expired — reconnect needed")).toBe(false);
    expect(isTransientBackupStorageError("Refusing to overwrite a backup for a different wallet")).toBe(false);
    expect(isTransientBackupStorageError("")).toBe(false);
  });
});
