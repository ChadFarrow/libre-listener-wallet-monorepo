import { describe, it, expect } from "vitest";
import {
  backupAheadOfLocal,
  BackupAheadError,
  isBackupAheadError,
  BACKUP_AHEAD_CODE,
} from "./backup-ahead";

describe("backupAheadOfLocal", () => {
  it("is true only when the backup is strictly ahead of local", () => {
    expect(backupAheadOfLocal(193, 249)).toBe(true); // the incident: local rolled back, backup current
    expect(backupAheadOfLocal(249, 249)).toBe(false); // in sync — normal
    expect(backupAheadOfLocal(250, 249)).toBe(false); // local ahead (backup just stale) — don't block
    expect(backupAheadOfLocal(0, 1)).toBe(true);
    expect(backupAheadOfLocal(0, 0)).toBe(false);
  });

  it("coerces junk/negative/NaN to 0 rather than mis-triggering", () => {
    expect(backupAheadOfLocal(NaN, 5)).toBe(true); // local unknown, backup has state → treat local as 0
    expect(backupAheadOfLocal(5, NaN)).toBe(false); // backup unknown → never block on it
    expect(backupAheadOfLocal(-3, -1)).toBe(false); // both floor to 0
    expect(backupAheadOfLocal(2.9, 3.1)).toBe(true); // floors: 2 < 3
    expect(backupAheadOfLocal(3.9, 3.1)).toBe(false); // floors: 3 == 3
  });
});

describe("BackupAheadError", () => {
  it("carries a boundary-stable code, the versions, and a code token in the message", () => {
    const e = new BackupAheadError(193, 249);
    expect(e.code).toBe(BACKUP_AHEAD_CODE);
    expect(e.localVersion).toBe(193);
    expect(e.backupVersion).toBe(249);
    expect(e.message).toContain(`[${BACKUP_AHEAD_CODE}]`);
    expect(isBackupAheadError(e)).toBe(true);
  });

  it("isBackupAheadError matches a flattened error via the message token (cross-boundary)", () => {
    expect(isBackupAheadError({ message: `nope [${BACKUP_AHEAD_CODE}]` })).toBe(true);
    expect(isBackupAheadError({ code: BACKUP_AHEAD_CODE })).toBe(true);
    expect(isBackupAheadError(new Error("unrelated"))).toBe(false);
    expect(isBackupAheadError(undefined)).toBe(false);
    expect(isBackupAheadError("BACKUP_AHEAD")).toBe(false); // a bare string isn't our error
  });
});
