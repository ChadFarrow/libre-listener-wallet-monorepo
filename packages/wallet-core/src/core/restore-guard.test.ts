import { describe, it, expect } from "vitest";
import {
  restoreBlockReason,
  mayOverwriteStaleLocal,
  RESTORE_RUNNING_MSG,
  RESTORE_IN_PROGRESS_MSG,
  RESTORE_FUNDED_MSG,
} from "./restore-guard";

describe("restoreBlockReason", () => {
  it("blocks when a node is running (overwrite / zombie-node hazard)", () => {
    expect(restoreBlockReason({ running: true, restoring: false, targetHasChannelState: false })).toBe(
      RESTORE_RUNNING_MSG
    );
  });

  it("blocks a concurrent restore (double-click race)", () => {
    expect(restoreBlockReason({ running: false, restoring: true, targetHasChannelState: false })).toBe(
      RESTORE_IN_PROGRESS_MSG
    );
  });

  it("blocks overwriting an existing funded wallet on the target network", () => {
    expect(restoreBlockReason({ running: false, restoring: false, targetHasChannelState: true })).toBe(
      RESTORE_FUNDED_MSG
    );
  });

  it("allows a restore into a stopped, empty network DB", () => {
    expect(restoreBlockReason({ running: false, restoring: false, targetHasChannelState: false })).toBeNull();
  });

  it("prioritizes the running check over the funded check", () => {
    expect(restoreBlockReason({ running: true, restoring: false, targetHasChannelState: true })).toBe(
      RESTORE_RUNNING_MSG
    );
  });
});

describe("mayOverwriteStaleLocal", () => {
  const base = {
    hasLocalChannelState: true,
    backupDecryptsWithLocalSeed: true,
    localStateVersion: 90,
    backupStateVersion: 113,
  };

  it("permits the overwrite when the backup supersedes stale local state (BACKUP_AHEAD recovery)", () => {
    expect(mayOverwriteStaleLocal(base)).toBe(true);
  });

  it("refuses when there is no local channel state (nothing to protect — ordinary path handles it)", () => {
    expect(mayOverwriteStaleLocal({ ...base, hasLocalChannelState: false })).toBe(false);
  });

  it("refuses when the backup is NOT the same wallet (does not decrypt with the local seed)", () => {
    expect(mayOverwriteStaleLocal({ ...base, backupDecryptsWithLocalSeed: false })).toBe(false);
  });

  it("refuses when the backup version is unknown", () => {
    expect(mayOverwriteStaleLocal({ ...base, backupStateVersion: null })).toBe(false);
  });

  it("refuses when the backup is equal to or behind local (a stale backup must never clobber)", () => {
    expect(mayOverwriteStaleLocal({ ...base, backupStateVersion: 90 })).toBe(false);
    expect(mayOverwriteStaleLocal({ ...base, backupStateVersion: 42 })).toBe(false);
  });

  it("treats a missing/zero local version with an ahead backup as overwritable", () => {
    expect(mayOverwriteStaleLocal({ ...base, localStateVersion: 0, backupStateVersion: 1 })).toBe(true);
  });
});
