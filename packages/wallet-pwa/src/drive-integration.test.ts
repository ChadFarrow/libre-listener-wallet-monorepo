import { describe, it, expect, vi, beforeEach } from "vitest";

// Demo mode must be off so ensureDriveConnected doesn't short-circuit to the demo error.
vi.mock("./core/demo-mode", () => ({ isDemoMode: () => false, demoState: {} }));

// Mock only the Drive REST calls; keep the REAL DriveForeignBackupError / isDriveForeignBackupError
// so the guard's thrown error is the genuine typed one. vi.hoisted so the spies exist when the
// (hoisted) vi.mock factory runs.
const { uploadBackup, dl } = vi.hoisted(() => ({
  uploadBackup: vi.fn(async () => {}),
  dl: { result: null as string | null },
}));
vi.mock("@libre/wallet-core", async (importActual) => {
  const actual = await importActual<typeof import("@libre/wallet-core")>();
  return {
    ...actual,
    isConnected: () => true, // ensureDriveConnected returns early
    getConnectedEmail: () => "u@example.com",
    downloadBackup: vi.fn(async () => dl.result),
    uploadBackup,
  };
});

import { driveBackupNow } from "./drive-integration";
import { isDriveForeignBackupError } from "@libre/wallet-core";

function fakeController(opts: { isOurs: boolean; seedHex: string }): any {
  return {
    exportBackup: async () => "env-new",
    getState: async () => ({ network: "mainnet" }),
    getSeed: async () => ({ seedHex: opts.seedHex }),
    backupIsOurs: async (_env: string) => opts.isOurs,
  };
}

describe("driveBackupNow — iOS-eviction overwrite guard", () => {
  beforeEach(() => {
    uploadBackup.mockClear();
    dl.result = null;
  });

  it("uploads when Drive has no existing backup for the network", async () => {
    dl.result = null;
    await driveBackupNow(fakeController({ isOurs: false, seedHex: "1".repeat(64) }));
    expect(uploadBackup).toHaveBeenCalledTimes(1);
  });

  it("overwrites when the existing backup IS ours (decrypts with our seed)", async () => {
    dl.result = "env-existing-ours";
    await driveBackupNow(fakeController({ isOurs: true, seedHex: "2".repeat(64) }));
    expect(uploadBackup).toHaveBeenCalledTimes(1);
  });

  it("REFUSES to overwrite a backup that belongs to a DIFFERENT wallet (fund-loss guard)", async () => {
    dl.result = "env-existing-foreign";
    let err: unknown;
    await driveBackupNow(fakeController({ isOurs: false, seedHex: "3".repeat(64) })).catch((e) => (err = e));
    expect(isDriveForeignBackupError(err)).toBe(true);
    expect(uploadBackup).not.toHaveBeenCalled();
  });

  it("only checks ownership once per (seed, network) — later syncs skip the download+decrypt", async () => {
    const ctl = fakeController({ isOurs: true, seedHex: "4".repeat(64) });
    dl.result = "env-existing-ours";
    await driveBackupNow(ctl); // confirms ownership, caches it
    // A subsequent sync must upload without re-checking, even if Drive now looks foreign.
    dl.result = "env-now-foreign";
    (ctl as any).backupIsOurs = async () => false;
    await driveBackupNow(ctl);
    expect(uploadBackup).toHaveBeenCalledTimes(2);
  });
});
