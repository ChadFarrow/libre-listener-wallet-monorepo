import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { IndexedDBStorageProvider } from "@libre/listener-wallet";
import { WalletController } from "./wallet-controller";
import { dbNameForNetwork } from "./core/storage-namespace";

// The default active network with no meta pointer is mainnet (core/sw-config.ts
// resolveActiveNetwork rule) — seed the mainnet DB so the stopped-path reads find it.
const DB = dbNameForNetwork("mainnet");

describe("WalletController.getPayments (node stopped)", () => {
  beforeEach(async () => {
    await new IndexedDBStorageProvider(DB).clear();
  });

  it("reads the persisted payment history without a running node, newest-first", async () => {
    const storage = new IndexedDBStorageProvider(DB);
    const older = {
      id: "aa".repeat(32),
      direction: "sent",
      status: "settled",
      amountSats: 47,
      timestamp: 1_700_000_000_000,
      type: "keysend",
      note: "ECHO REALITY · PINK FLIGHT",
    };
    const newer = {
      id: "bb".repeat(32),
      direction: "received",
      status: "settled",
      amountSats: 5000,
      timestamp: 1_700_000_100_000,
    };
    await storage.setItem(`tx_${older.id}`, JSON.stringify(older));
    await storage.setItem(`tx_${newer.id}`, JSON.stringify(newer));

    const controller = new WalletController();
    const records = await controller.getPayments();
    expect(records.map((r) => r.id)).toEqual([newer.id, older.id]);
    expect(records[1].note).toBe("ECHO REALITY · PINK FLIGHT");
  });

  it("returns an empty list for a fresh wallet", async () => {
    const controller = new WalletController();
    await expect(controller.getPayments()).resolves.toEqual([]);
  });
});

describe("WalletController.payLightning input validation (no node needed)", () => {
  it("rejects unrecognized input before touching the wallet", async () => {
    const controller = new WalletController();
    await expect(controller.payLightning("not-a-payment-thing")).rejects.toThrow(/invoice or lightning address/i);
  });

  it("requires an amount for a lightning address", async () => {
    const controller = new WalletController();
    await expect(controller.payLightning("chad@getalby.com")).rejects.toThrow(/amount/i);
  });
});

describe("WalletController node alias (node stopped) — cross-device sync", () => {
  beforeEach(async () => {
    await new IndexedDBStorageProvider(DB).clear();
  });

  it("saves the alias to the backed-up `node_alias` key so it rides the backup", async () => {
    const controller = new WalletController();
    await controller.setNodeAlias("  Chad's phone  ");
    // BACKUP_DIRECT_KEYS includes node_alias, so exportState will carry exactly this value.
    expect(await new IndexedDBStorageProvider(DB).getItem("node_alias")).toBe("Chad's phone");
    expect((await controller.getConfig()).nodeAlias).toBe("Chad's phone");
  });

  it("clearing the alias removes the key (and can't reappear)", async () => {
    const controller = new WalletController();
    await controller.setNodeAlias("Node");
    await controller.setNodeAlias("");
    expect(await new IndexedDBStorageProvider(DB).getItem("node_alias")).toBeNull();
    expect((await controller.getConfig()).nodeAlias).toBeUndefined();
  });

  it("migrates a pre-sync alias stored inside ldk_config into the dedicated backed-up key", async () => {
    const storage = new IndexedDBStorageProvider(DB);
    // Legacy install: alias lived inside device-specific ldk_config, never backed up.
    await storage.setItem("ldk_config", JSON.stringify({ network: "mainnet", nodeAlias: "Legacy name", esploraUrl: "https://x/api" }));
    const controller = new WalletController();
    expect((await controller.getConfig()).nodeAlias).toBe("Legacy name");
    // First read migrated it to the dedicated key — now exportState includes it.
    expect(await storage.getItem("node_alias")).toBe("Legacy name");
  });

  it("a restored backup's node_alias surfaces on this device (fresh ldk_config)", async () => {
    // Simulate importState having written the backed-up key onto a fresh device.
    const storage = new IndexedDBStorageProvider(DB);
    await storage.setItem("node_alias", "Restored name");
    const controller = new WalletController();
    expect((await controller.getConfig()).nodeAlias).toBe("Restored name");
  });
});

describe("WalletController.listPeers (node stopped)", () => {
  beforeEach(async () => {
    await new IndexedDBStorageProvider(DB).clear();
  });

  it("returns address-book rows as disconnected when the node is stopped", async () => {
    const pk = "02" + "ab".repeat(32);
    const storage = new IndexedDBStorageProvider(DB);
    await storage.setItem("peer_addresses", JSON.stringify({ [pk]: { host: "1.2.3.4", port: 9735 } }));
    const controller = new WalletController();
    const rows = await controller.listPeers();
    expect(rows).toEqual([{ pubkey: pk, address: "1.2.3.4:9735", connected: false, hasChannel: false }]);
  });
});
