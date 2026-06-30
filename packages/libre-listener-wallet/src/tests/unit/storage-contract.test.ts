// @vitest-environment node
//
// ⚠️ STORAGE CONTRACT — DO NOT "fix" a failing assertion by editing the expected
// value. These constants are the on-disk format for funded wallet state in a live
// browser's IndexedDB. Changing one orphans existing channel state (the node can't
// find its channel_manager → force-close) or makes existing encrypted backups
// undecryptable (the last-resort recovery path dies silently). Either way: lost
// funds. To change a constant, write a migration first, change it deliberately, and
// update this test in the SAME commit so the break is explicit and reviewed.
//
// Related (already pinned elsewhere): storage-namespace.test.ts (DB-name-by-network,
// migration), storage.test.ts (the `/`-joined KVStore key format + ldk_keys_index
// JSON shape), state-version.test.ts, persistence.test.ts. This file pins the gaps:
// the physical IndexedDB layout, the backup envelope format (by behaviour, via frozen
// golden envelopes), and the backup direct-key set.

import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { IndexedDBStorageProvider } from "../../indexed-db-storage";
import { decryptAndParse, type BackupPayload } from "../../state-backup";
import { BACKUP_DIRECT_KEYS } from "../../backup-keys";

// --- Physical IndexedDB layout --------------------------------------------------
// The default (legacy/un-namespaced) DB name, object store name, and DB version are
// the IndexedDBStorageProvider constructor defaults. The example app opens
// `libre-wallet-<network>` over this same provider, and migrateStorage reads the
// legacy `libre-wallet` DB — so both the default name and the store/version must
// stay fixed or a deployed wallet stops finding its data.
describe("storage contract: IndexedDB physical layout", () => {
  it("default DB name `libre-wallet`, object store `settings`, version 1", async () => {
    const provider = new IndexedDBStorageProvider(); // defaults
    await provider.setItem("contract-probe", "1"); // forces open + upgrade

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("libre-wallet");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      expect(db.name).toBe("libre-wallet");
      expect(db.version).toBe(1);
      expect(Array.from(db.objectStoreNames)).toContain("settings");
    } finally {
      db.close();
    }
  });
});

// --- Backup envelope format (frozen golden envelopes) ---------------------------
// These envelopes were produced by the CURRENT code for a known seed/passphrase/
// payload and frozen here. If a refactor changes the HKDF `info` strings, the PBKDF2
// iteration count, the AES params, or the envelope version tags, decryptAndParse can
// no longer recover these — i.e. real backups made by older builds stop restoring.
// That is exactly the failure we must catch before it ships.
const SEED_HEX = "1111111111111111111111111111111111111111111111111111111111111111";
const PASSPHRASE = "libre-contract-test-passphrase";
const GOLDEN_PAYLOAD: BackupPayload = {
  version: 1,
  network: "mainnet",
  exportedAt: 1700000000000,
  entries: {
    ldk_seed: SEED_HEX,
    channel_manager: "deadbeef",
    network_graph: "cafe",
    scorer: "f00d",
    state_version: "7",
    ldk_keys_index: '["monitors/abc/0"]',
    "monitors/abc/0": "00ff",
  },
};

// v1 (legacy, seed-only HKDF). info = "libre-wallet-backup-v1".
const GOLDEN_V1 =
  '{"v":1,"alg":"AES-256-GCM","kdf":"HKDF-SHA256","iv":"PMjzFpZPU0Wj8m01","ct":"3PbZ2gPemUfHbZT32Xhw2GrYSSzaTsj1u64hiA6l+WdJ06xs5eCHHXq5QBx4tVc5ZYmySx38QuOF4LEcqCLI/UbwAcsZx97P5rTAVFQlhZRSKVQDy6hqfbqklDaEIT3jeAKPEXJodbnN5iVfYEcp00yno1dftyExjtHAKlDqzy7Uuw2grCFw/oowaapKbAGhEpFNGoNa1jVdWWIKNHPXpzU8LLSPglU1//R5TQE11NcAS3K5SbX5khpzah35Cz/j47UvVNYuy9v7n38h8ErmA+bmfX88TmCvvdR55RIUoH8uZdVhfaHzrn1A8eQs/DUMIrID69tAOyUczOim3SEjxWNjZj4HSRVWuCK+Ge+dBffzwdg7YXE287hF7FuKlQOKGzZEiYbaAB2Qz0mB9F5zKzqWVbixL8lyc9J3QKuK"}';

// v2 (current, DEK wrapped to BOTH passphrase-PBKDF2 and seed-HKDF).
// seed recipient info = "libre-wallet-backup-kek-v2", PBKDF2 iter = 600000.
const GOLDEN_V2 =
  '{"v":2,"alg":"AES-256-GCM","iv":"kSJCASTsc0y80RrE","ct":"gwrVnvH0MLpbkn5U40QgbirUTwLy/4ILdwO7I97gkNp0MY9D+afxpRYGG4iTlpyewBL6PO8TDdqjARilslm59XFcxFDjhhTBY64Txecz/rJiU1cqLIV2DIKS6UZxoJiUNN/Wb35e3YqWbgcH+H0ne9dmKbjZ43OW+EMbgkCBVD+iCgrWYN6a6m0QTXjI5pMpZIOqhWW0vpv11QelQlhwZ0YygljL8vbf0DF/s5ChvFne/123iQOyyjKSW9jQuWyNKL6/niQ/zlKFMLGKJOkfXfEpOq0cZJHZGcXUPJOY2jD0jGqL/MiURD1QPlg+kJ7XPGQ/Oq/oCPs32aJYxE0UpVyqTg+XpgpVWg0yjhD+AnBmnUGLtd3pTPex+JP67q8Zi5JomDmb7IleOS+uk5rHjS+r6KcKQ8xky3ZyO+Qf","recipients":[{"type":"passphrase","kdf":"PBKDF2-SHA256","iter":600000,"salt":"rvtikSmE6cPV6sergqktPA==","iv":"c2SYIPsDcNb5i1zM","wrap":"3TwRN/mSjXauBpuLL2jft1jWaHjhbM2aOvCo+H6DDmRez/c5X8C+FjMCzxhxDLAV"},{"type":"seed","kdf":"HKDF-SHA256","info":"libre-wallet-backup-kek-v2","iv":"QpRYQB6jAtLYCZfu","wrap":"ElvryG0gTQCv+oh97i9bZn59Sk4Y9ZmiWo3etBSyaeghxcx3WNsq4UvcMVnaGpFi"}]}';

describe("storage contract: backup envelope is forward-restorable", () => {
  it("a frozen v1 (seed-only) backup still decrypts with the seed", async () => {
    expect(await decryptAndParse(GOLDEN_V1, SEED_HEX)).toEqual(GOLDEN_PAYLOAD);
  });

  it("a frozen v2 backup still decrypts with the passphrase", async () => {
    expect(await decryptAndParse(GOLDEN_V2, PASSPHRASE)).toEqual(GOLDEN_PAYLOAD);
  });

  it("a frozen v2 backup still decrypts with the seed", async () => {
    expect(await decryptAndParse(GOLDEN_V2, SEED_HEX)).toEqual(GOLDEN_PAYLOAD);
  });

  it("the v2 envelope shape constants are unchanged", () => {
    const env = JSON.parse(GOLDEN_V2);
    expect(env.v).toBe(2);
    expect(env.alg).toBe("AES-256-GCM");
    const pass = env.recipients.find((r: { type: string }) => r.type === "passphrase");
    const seed = env.recipients.find((r: { type: string }) => r.type === "seed");
    expect(pass.kdf).toBe("PBKDF2-SHA256");
    expect(pass.iter).toBe(600000);
    expect(seed.kdf).toBe("HKDF-SHA256");
    expect(seed.info).toBe("libre-wallet-backup-kek-v2");
  });

  it("the v1 envelope shape constants are unchanged", () => {
    const env = JSON.parse(GOLDEN_V1);
    expect(env.v).toBe(1);
    expect(env.alg).toBe("AES-256-GCM");
    expect(env.kdf).toBe("HKDF-SHA256");
  });
});

// --- Backup direct-key set ------------------------------------------------------
// exportState() copies exactly these top-level keys into the backup (then appends
// the monitor keys from ldk_keys_index). Dropping one silently produces an
// incomplete, unrestorable backup.
describe("storage contract: backup direct-key set", () => {
  it("includes the seed + every piece of channel state", () => {
    expect([...BACKUP_DIRECT_KEYS]).toEqual([
      "ldk_seed",
      "channel_manager",
      "network_graph",
      "scorer",
      "ldk_keys_index",
      "state_version",
    ]);
  });
});
