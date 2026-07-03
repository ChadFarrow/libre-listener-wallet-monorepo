import { describe, it, expect } from "vitest";
import { dbNameForNetwork, META_DB_NAME, ACTIVE_NETWORK_KEY } from "./storage-namespace";
import { CONFIG_KEY } from "./wallet-config";
import { backupFilename, networkFromBackupFilename } from "./drive-rest";

// Pins the on-disk invariants the extension COPIED from the PWA/SDK (packages/example-app and
// packages/libre-listener-wallet own the originals + their own contract tests + the pre-push /
// deploy guard). The extension is a separate chrome-extension:// storage origin, so it is OUTSIDE
// that guard — this test is its stand-in. A funded extension wallet's IndexedDB is keyed by these
// names and its Drive backup by this filename; changing any of them orphans state (force-close) or
// makes existing backups unrestorable. Do NOT "fix" a failing value here — a break means a pinned
// invariant drifted. Change it deliberately, with a migration, in the same commit.
describe("extension storage contract (copied invariants — must match the PWA/SDK)", () => {
  it("pins the per-network IndexedDB name", () => {
    expect(dbNameForNetwork("mainnet")).toBe("libre-wallet-mainnet");
    expect(dbNameForNetwork("signet")).toBe("libre-wallet-signet");
    expect(dbNameForNetwork("regtest")).toBe("libre-wallet-regtest");
  });

  it("pins the meta DB + active-network pointer", () => {
    expect(META_DB_NAME).toBe("libre-wallet-meta");
    expect(ACTIVE_NETWORK_KEY).toBe("active_network");
  });

  it("pins the persisted runtime-config key", () => {
    expect(CONFIG_KEY).toBe("ldk_config");
  });

  it("pins the per-network Drive backup filename (cross-restorable with the PWA)", () => {
    expect(backupFilename("mainnet")).toBe("libre-wallet-backup-mainnet.json");
    expect(networkFromBackupFilename("libre-wallet-backup-mainnet.json")).toBe("mainnet");
    // Round-trips for every network.
    for (const n of ["mainnet", "testnet", "signet", "regtest"]) {
      expect(networkFromBackupFilename(backupFilename(n))).toBe(n);
    }
  });
});
