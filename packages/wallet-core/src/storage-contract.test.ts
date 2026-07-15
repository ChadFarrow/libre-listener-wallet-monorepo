// ⚠️ STORAGE CONTRACT — DO NOT "fix" a failing assertion by editing the expected
// value. These constants now LIVE in @libre/wallet-core and are how every consumer
// app (wallet PWA, browser extension host, embeddable widget) addresses a live
// wallet's data. Change one and a funded wallet stops finding its channel state on
// the next load (force-close), or a backup becomes unlocatable. To change a
// constant: write a migration, change it deliberately, and update this test in the
// SAME commit. Per-app suites (wallet-pwa, browser-extension, example-app) pin the
// same values at their boundaries; the SDK envelope format is pinned in
// packages/libre-listener-wallet/src/tests/unit/storage-contract.test.ts.

import { describe, it, expect } from "vitest";
import { dbNameForNetwork, META_DB_NAME, ACTIVE_NETWORK_KEY } from "./core/storage-namespace";
import { resolveSwConfig } from "./core/sw-config";
import { mirrorKeyForNetwork } from "./core/state-version-mirror";
import { backupFilename, networkFromBackupFilename } from "./drive-backup";
import { leaseFilename } from "./roaming/drive-lease";

describe("storage contract: per-network DB name", () => {
  it("is `libre-wallet-<network>` for every supported network", () => {
    expect(dbNameForNetwork("mainnet")).toBe("libre-wallet-mainnet");
    expect(dbNameForNetwork("signet")).toBe("libre-wallet-signet");
    expect(dbNameForNetwork("regtest")).toBe("libre-wallet-regtest");
    expect(dbNameForNetwork("testnet")).toBe("libre-wallet-testnet");
  });
});

describe("storage contract: active-network pointer", () => {
  it("meta DB name and pointer key are fixed", () => {
    expect(META_DB_NAME).toBe("libre-wallet-meta");
    expect(ACTIVE_NETWORK_KEY).toBe("active_network");
  });
});

describe("storage contract: service-worker default network", () => {
  it("falls back to regtest when config is absent or malformed", () => {
    expect(resolveSwConfig(null).network).toBe("regtest");
    expect(resolveSwConfig("not json").network).toBe("regtest");
  });
});

// The offline rollback witness (state-version high-water mark) lives in localStorage under this
// key. A drifted key would silently disable the rolled-back-storage guard for existing wallets.
describe("storage contract: state-version mirror key", () => {
  it("is `libre_state_version_hwm:<network>`", () => {
    expect(mirrorKeyForNetwork("mainnet")).toBe("libre_state_version_hwm:mainnet");
    expect(mirrorKeyForNetwork("")).toBe("libre_state_version_hwm:mainnet");
  });
});

// The roaming lease file: every origin (and app version) must coordinate on the SAME Drive file —
// a renamed lease means two versions "coordinate" on different files, i.e. no single-instance
// guard at all, i.e. two live nodes on one channel (force-close).
describe("storage contract: roaming lease filename", () => {
  it("is `libre-wallet-lease-<network>.json`", () => {
    expect(leaseFilename("mainnet")).toBe("libre-wallet-lease-mainnet.json");
    expect(leaseFilename("regtest")).toBe("libre-wallet-lease-regtest.json");
  });
});

describe("storage contract: Drive backup filename", () => {
  it("filename format and its parser round-trip", () => {
    expect(backupFilename("mainnet")).toBe("libre-wallet-backup-mainnet.json");
    expect(networkFromBackupFilename("libre-wallet-backup-mainnet.json")).toBe("mainnet");
    expect(networkFromBackupFilename("libre-wallet-backup-signet.json")).toBe("signet");
    expect(networkFromBackupFilename("unrelated.json")).toBeNull();
  });
});
