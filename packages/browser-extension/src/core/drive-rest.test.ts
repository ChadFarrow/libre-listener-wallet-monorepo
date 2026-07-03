import { describe, it, expect } from "vitest";
import { backupFilename, networkFromBackupFilename, pickRestoreNetwork } from "./drive-rest";

describe("drive backup filenames", () => {
  it("names one file per network (matches the PWA/storage-contract format)", () => {
    expect(backupFilename("mainnet")).toBe("libre-wallet-backup-mainnet.json");
    expect(backupFilename("signet")).toBe("libre-wallet-backup-signet.json");
  });

  it("parses the network back out of a filename", () => {
    expect(networkFromBackupFilename("libre-wallet-backup-mainnet.json")).toBe("mainnet");
    expect(networkFromBackupFilename("something-else.json")).toBeNull();
  });

  it("round-trips network → filename → network", () => {
    for (const n of ["mainnet", "testnet", "signet", "regtest"]) {
      expect(networkFromBackupFilename(backupFilename(n))).toBe(n);
    }
  });
});

describe("pickRestoreNetwork", () => {
  it("prefers mainnet when present", () => {
    expect(pickRestoreNetwork(["signet", "mainnet"])).toBe("mainnet");
  });

  it("falls back to the first network otherwise", () => {
    expect(pickRestoreNetwork(["signet", "regtest"])).toBe("signet");
  });

  it("returns null when there are no backups", () => {
    expect(pickRestoreNetwork([])).toBeNull();
  });
});
