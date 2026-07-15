import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  nativeBackupAvailable,
  detectBackupTargets,
  backupFolderConfigured,
  backupTargetLabel,
  chooseBackupFolder,
  clearBackupFolder,
  nativeBackupNow,
  nativeBackupNetworks,
  nativeRestore,
  type BackupStoragePlugin,
} from "./native-backup";
import { DriveForeignBackupError } from "@libre/wallet-core";
import type { WalletControllerApi } from "@libre/wallet-core";

const g = globalThis as unknown as {
  __LIBRE_NATIVE__?: boolean;
  Capacitor?: unknown;
};

function installPlugin(overrides: Partial<BackupStoragePlugin> = {}): {
  writes: { name: string; contents: string }[];
} {
  const writes: { name: string; contents: string }[] = [];
  const plugin: BackupStoragePlugin = {
    detectTargets: async () => ({ local: true, gdrive: false }),
    pickFolder: async () => ({ treeUri: "content://com.android.externalstorage.documents/tree/primary" }),
    writeFile: async (o) => {
      writes.push({ name: o.name, contents: o.contents });
    },
    readFile: async () => ({ contents: "" }),
    listBackups: async () => ({ files: [] }),
    ...overrides,
  };
  g.__LIBRE_NATIVE__ = true;
  g.Capacitor = { Plugins: { LibreBackupStorage: plugin } };
  return { writes };
}

function clearAll() {
  delete g.__LIBRE_NATIVE__;
  delete g.Capacitor;
  localStorage.clear();
}

function mockController(over: Partial<WalletControllerApi> = {}): WalletControllerApi {
  return {
    exportBackup: async () => "ENVELOPE",
    getState: async () => ({ network: "mainnet" }),
    backupIsOurs: async () => true,
    restoreWallet: async () => ({ nodeId: "n", network: "mainnet" }),
    ...over,
  } as unknown as WalletControllerApi;
}

describe("nativeBackupAvailable", () => {
  beforeEach(clearAll);
  afterEach(clearAll);

  it("is false in a plain browser (no native, no plugin)", () => {
    expect(nativeBackupAvailable()).toBe(false);
  });

  it("is true when native + the plugin is registered", () => {
    installPlugin();
    expect(nativeBackupAvailable()).toBe(true);
  });
});

describe("detectBackupTargets", () => {
  beforeEach(clearAll);
  afterEach(clearAll);

  it("returns the plugin's target availability", async () => {
    installPlugin({ detectTargets: async () => ({ local: true, gdrive: true }) });
    expect(await detectBackupTargets()).toEqual({ local: true, gdrive: true });
  });

  it("falls back to local-only if the plugin throws", async () => {
    installPlugin({
      detectTargets: async () => {
        throw new Error("boom");
      },
    });
    expect(await detectBackupTargets()).toEqual({ local: true, gdrive: false });
  });
});

describe("choose / configured / label", () => {
  beforeEach(clearAll);
  afterEach(clearAll);

  it("starts unconfigured, becomes configured after choosing, and clears", async () => {
    installPlugin();
    expect(backupFolderConfigured()).toBe(false);
    await chooseBackupFolder();
    expect(backupFolderConfigured()).toBe(true);
    expect(backupTargetLabel()).toBe("Local storage");
    clearBackupFolder();
    expect(backupFolderConfigured()).toBe(false);
  });

  it("labels a Google Drive tree URI as Google Drive", async () => {
    installPlugin({
      pickFolder: async () => ({ treeUri: "content://com.google.android.apps.docs.storage/tree/abc" }),
    });
    await chooseBackupFolder();
    expect(backupTargetLabel()).toBe("Google Drive");
  });
});

describe("nativeBackupNow", () => {
  beforeEach(clearAll);
  afterEach(clearAll);

  it("writes the envelope under the network-scoped filename", async () => {
    const { writes } = installPlugin();
    await chooseBackupFolder();
    const res = await nativeBackupNow(mockController());
    expect(res.network).toBe("mainnet");
    expect(writes).toEqual([{ name: "libre-wallet-backup-mainnet.json", contents: "ENVELOPE" }]);
  });

  it("refuses to overwrite a backup that belongs to a DIFFERENT wallet", async () => {
    installPlugin({ readFile: async () => ({ contents: "SOMEONE_ELSES" }) });
    await chooseBackupFolder();
    const ctrl = mockController({ backupIsOurs: async () => false });
    await expect(nativeBackupNow(ctrl)).rejects.toBeInstanceOf(DriveForeignBackupError);
  });

  it("overwrites when the existing backup IS ours", async () => {
    const { writes } = installPlugin({ readFile: async () => ({ contents: "OURS" }) });
    await chooseBackupFolder();
    await nativeBackupNow(mockController({ backupIsOurs: async () => true }));
    expect(writes).toHaveLength(1);
  });

  it("throws if no folder is chosen", async () => {
    installPlugin();
    await expect(nativeBackupNow(mockController())).rejects.toThrow(/Choose a backup folder/);
  });
});

describe("networks + restore", () => {
  beforeEach(clearAll);
  afterEach(clearAll);

  it("parses networks from the folder's backup files", async () => {
    installPlugin({
      listBackups: async () => ({ files: ["libre-wallet-backup-mainnet.json", "junk.txt"] }),
    });
    await chooseBackupFolder();
    expect(await nativeBackupNetworks()).toEqual(["mainnet"]);
  });

  it("restores by reading the auto-detected network's backup file", async () => {
    let restored: { envelope: string; secret: string } | null = null;
    installPlugin({
      listBackups: async () => ({ files: ["libre-wallet-backup-mainnet.json"] }),
      readFile: async () => ({ contents: "ENVELOPE_FROM_FOLDER" }),
    });
    await chooseBackupFolder();
    const ctrl = mockController({
      restoreWallet: async (envelope: string, secret: string) => {
        restored = { envelope, secret };
        return { nodeId: "n", network: "mainnet" };
      },
    });
    await nativeRestore(ctrl, "my-seed");
    expect(restored).toEqual({ envelope: "ENVELOPE_FROM_FOLDER", secret: "my-seed" });
  });

  it("restore throws when the folder has no backup", async () => {
    installPlugin({ listBackups: async () => ({ files: [] }) });
    await chooseBackupFolder();
    await expect(nativeRestore(mockController(), "s")).rejects.toThrow(/No backup found/);
  });
});
