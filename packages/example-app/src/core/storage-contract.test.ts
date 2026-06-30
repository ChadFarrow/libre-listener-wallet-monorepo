// ⚠️ STORAGE CONTRACT — DO NOT "fix" a failing assertion by editing the expected
// value. These strings are how the deployed PWA addresses a live wallet's data in
// the browser's IndexedDB. Change one and a funded wallet stops finding its channel
// state on the next load (force-close), or off-page code (service worker, web-push)
// opens the wrong DB. To change a constant: write a migration, change it
// deliberately, and update this test in the SAME commit.
//
// SDK-side invariants (envelope format, physical store layout, backup key set) are
// pinned in packages/libre-listener-wallet/src/tests/unit/storage-contract.test.ts.

import { describe, it, expect } from "vitest";
import { dbNameForNetwork, META_DB_NAME, ACTIVE_NETWORK_KEY } from "./storage-namespace";
import { resolveSwConfig } from "./sw-config";
import { backupFilename, networkFromBackupFilename } from "../drive-backup";

// Per-network IndexedDB name. The app, the service worker, and web-push all derive
// the DB they open from this exact format; migrateStorage reads the legacy
// un-namespaced `libre-wallet` DB into it.
describe("storage contract: per-network DB name", () => {
  it("is `libre-wallet-<network>` for every supported network", () => {
    expect(dbNameForNetwork("mainnet")).toBe("libre-wallet-mainnet");
    expect(dbNameForNetwork("signet")).toBe("libre-wallet-signet");
    expect(dbNameForNetwork("regtest")).toBe("libre-wallet-regtest");
    expect(dbNameForNetwork("testnet")).toBe("libre-wallet-testnet");
  });
});

// The meta DB + pointer key let off-page code (service worker, simulate-offline)
// discover which network is active. If these drift between the app that WROTE the
// pointer and the SW that READS it, the SW boots the wrong (or an empty) wallet.
describe("storage contract: active-network pointer", () => {
  it("meta DB name and pointer key are fixed", () => {
    expect(META_DB_NAME).toBe("libre-wallet-meta");
    expect(ACTIVE_NETWORK_KEY).toBe("active_network");
  });
});

// The service worker has no DOM and falls back to this network when the persisted
// config is missing/unparseable. It must agree with the app's default.
describe("storage contract: service-worker default network", () => {
  it("falls back to regtest when config is absent or malformed", () => {
    expect(resolveSwConfig(null).network).toBe("regtest");
    expect(resolveSwConfig("not json").network).toBe("regtest");
  });
});

// Drive stores one encrypted backup per network under this filename. Restore lists
// Drive files and parses the network back out of the name — so the format and its
// inverse must round-trip, or auto-network-detected restore breaks.
describe("storage contract: Drive backup filename", () => {
  it("filename format and its parser round-trip", () => {
    expect(backupFilename("mainnet")).toBe("libre-wallet-backup-mainnet.json");
    expect(networkFromBackupFilename("libre-wallet-backup-mainnet.json")).toBe("mainnet");
    expect(networkFromBackupFilename("libre-wallet-backup-signet.json")).toBe("signet");
    expect(networkFromBackupFilename("unrelated.json")).toBeNull();
  });
});
