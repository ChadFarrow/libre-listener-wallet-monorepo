# Network-Namespaced Wallet Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each Bitcoin network its own IndexedDB (`libre-wallet-<network>`) so switching networks can never corrupt another network's wallet, with seamless one-time migration of existing un-namespaced data.

**Architecture:** Namespacing is app-layer — the example app builds a network-scoped `IndexedDBStorageProvider` per selected network; the SDK's keying is unchanged. A one-time auto-migration copies the legacy `libre-wallet` DB into the correct `libre-wallet-<network>` DB (never overwriting). The SDK gains one additive method (`keys()`) so migration can enumerate every key.

**Tech Stack:** TypeScript, IndexedDB, Vitest (jsdom), `fake-indexeddb` (new test-only dep), pnpm + Turborepo.

## Global Constraints

- Package manager **pnpm@10.10.0**; build via Turborepo.
- SDK (`@libre/listener-wallet`) MUST NOT import platform modules. The `navigator`/`window` and DB-naming logic live in the **example-app**. (guardrail)
- No new **runtime** deps; `fake-indexeddb` is **devDependency** only.
- DB name format is exactly `libre-wallet-${network}` where network ∈ `mainnet|testnet|regtest|signet`.
- Migration must **never overwrite** a non-empty target and must leave the legacy `libre-wallet` DB intact.
- TDD: red→green→refactor. Do NOT mock LDK internals; use real `fake-indexeddb` and Map-backed doubles. (testing-strategy)
- Files kebab-case; Types PascalCase; vars/functions camelCase.
- Never commit to `master` directly; work on a feature branch; no commit without human approval. (CLAUDE.md)

---

## File Structure

- `packages/libre-listener-wallet/src/indexed-db-storage.ts` — **modify**: add `keys()`.
- `packages/libre-listener-wallet/src/tests/unit/indexed-db-storage.test.ts` — **create**: provider round-trip + cross-DB isolation (via `fake-indexeddb`).
- `packages/libre-listener-wallet/package.json` — **modify**: add `fake-indexeddb` devDep.
- `packages/example-app/src/core/storage-namespace.ts` — **create**: `dbNameForNetwork`, `migrateStorage`, store interfaces.
- `packages/example-app/src/core/storage-namespace.test.ts` — **create**: Map-double tests.
- `packages/example-app/src/main.ts` — **modify**: network-scoped `storage`, `refreshWalletForNetwork`, guarded network switch, load-time migration.

---

## Task 0: Feature branch

- [ ] **Step 1: Create the branch**

Run:
```bash
cd /Users/chad-mini/Vibe/libre-listener-wallet-monorepo
git checkout -b feat/network-namespaced-storage
```
Expected: `Switched to a new branch 'feat/network-namespaced-storage'`

---

## Task 1: SDK `IndexedDBStorageProvider.keys()` + real-IDB tests

**Files:**
- Modify: `packages/libre-listener-wallet/src/indexed-db-storage.ts`
- Modify: `packages/libre-listener-wallet/package.json` (add `fake-indexeddb` devDep)
- Test: `packages/libre-listener-wallet/src/tests/unit/indexed-db-storage.test.ts` (create)

**Interfaces:**
- Produces: `IndexedDBStorageProvider.keys(): Promise<string[]>` (lists all keys in the store). Existing `getItem/setItem/removeItem/clear` unchanged.

- [ ] **Step 1: Add fake-indexeddb devDep + install**

Edit `packages/libre-listener-wallet/package.json` devDependencies, adding (keep alphabetical-ish):
```json
    "fake-indexeddb": "^6.0.0",
```
Run:
```bash
pnpm install
```
Expected: install completes; `fake-indexeddb` present under the wallet package.

- [ ] **Step 2: Write the failing test**

Create `packages/libre-listener-wallet/src/tests/unit/indexed-db-storage.test.ts`:
```ts
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { IndexedDBStorageProvider } from "../../indexed-db-storage";

describe("IndexedDBStorageProvider", () => {
  it("round-trips set/get/remove/clear", async () => {
    const s = new IndexedDBStorageProvider("test-roundtrip");
    await s.setItem("a", "1");
    expect(await s.getItem("a")).toBe("1");
    await s.removeItem("a");
    expect(await s.getItem("a")).toBeNull();
    await s.setItem("b", "2");
    await s.clear();
    expect(await s.getItem("b")).toBeNull();
  });

  it("keys() lists every stored key (incl. untracked preimage_*)", async () => {
    const s = new IndexedDBStorageProvider("test-keys");
    await s.setItem("ldk_seed", "aa");
    await s.setItem("preimage_x", "bb");
    await s.setItem("monitors/y", "cc");
    expect((await s.keys()).sort()).toEqual(["ldk_seed", "monitors/y", "preimage_x"]);
  });

  it("isolates two different DB names", async () => {
    const reg = new IndexedDBStorageProvider("libre-wallet-regtest");
    const main = new IndexedDBStorageProvider("libre-wallet-mainnet");
    await reg.setItem("ldk_seed", "regtestseed");
    expect(await main.getItem("ldk_seed")).toBeNull();
    expect(await reg.getItem("ldk_seed")).toBe("regtestseed");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/indexed-db-storage.test.ts`
Expected: FAIL on the `keys()` test — `s.keys is not a function`.

- [ ] **Step 4: Implement `keys()`**

In `indexed-db-storage.ts`, add this method to the class (e.g. right after `clear()`):
```ts
  // Enumerate every key in the store — used by app-layer migration to copy a full
  // legacy DB into a network-scoped one (including preimage_* keys not tracked in
  // ldk_keys_index).
  async keys(): Promise<string[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const req = tx.objectStore(this.storeName).getAllKeys();
      req.onsuccess = () => resolve((req.result as IDBValidKey[]).map((k) => String(k)));
      req.onerror = () => reject(req.error);
    });
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/indexed-db-storage.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Full SDK suite (no regressions)**

Run: `pnpm --filter @libre/listener-wallet test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/libre-listener-wallet/src/indexed-db-storage.ts packages/libre-listener-wallet/src/tests/unit/indexed-db-storage.test.ts packages/libre-listener-wallet/package.json pnpm-lock.yaml
git commit -m "feat(sdk): IndexedDBStorageProvider.keys() + real-IDB tests"
```

---

## Task 2: App `core/storage-namespace.ts` (naming + migration helper)

**Files:**
- Create: `packages/example-app/src/core/storage-namespace.ts`
- Test: `packages/example-app/src/core/storage-namespace.test.ts`

**Interfaces:**
- Produces:
  - `dbNameForNetwork(network: string): string`
  - `ReadableStore` = `{ keys(): Promise<string[]>; getItem(k: string): Promise<string | null> }`
  - `WritableStore` = `{ getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void> }`
  - `migrateStorage(source: ReadableStore, target: WritableStore): Promise<number>` — copies all keys ONLY if target has no `ldk_seed`; returns count copied (0 = skipped).

- [ ] **Step 1: Write the failing test**

Create `packages/example-app/src/core/storage-namespace.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { dbNameForNetwork, migrateStorage } from "./storage-namespace";

function mem(init: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(init));
  return {
    m,
    keys: async () => [...m.keys()],
    getItem: async (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: async (k: string, v: string) => { m.set(k, v); },
  };
}

describe("dbNameForNetwork", () => {
  it("scopes the DB name by network", () => {
    expect(dbNameForNetwork("mainnet")).toBe("libre-wallet-mainnet");
    expect(dbNameForNetwork("regtest")).toBe("libre-wallet-regtest");
  });
});

describe("migrateStorage", () => {
  it("copies all keys (incl. preimage_*/monitors) into an empty target", async () => {
    const src = mem({ ldk_seed: "aa", channel_manager: "bb", preimage_x: "cc", "monitors/y": "dd" });
    const dst = mem();
    expect(await migrateStorage(src, dst)).toBe(4);
    expect(dst.m.get("ldk_seed")).toBe("aa");
    expect(dst.m.get("preimage_x")).toBe("cc");
    expect(dst.m.get("monitors/y")).toBe("dd");
  });

  it("skips and never overwrites a target that already has a wallet", async () => {
    const src = mem({ ldk_seed: "new", channel_manager: "new" });
    const dst = mem({ ldk_seed: "existing" });
    expect(await migrateStorage(src, dst)).toBe(0);
    expect(dst.m.get("ldk_seed")).toBe("existing");
    expect(dst.m.has("channel_manager")).toBe(false);
  });

  it("empty source copies nothing", async () => {
    expect(await migrateStorage(mem(), mem())).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @libre/example-app exec vitest run src/core/storage-namespace.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `packages/example-app/src/core/storage-namespace.ts`:
```ts
// Per-network storage isolation. Each Bitcoin network gets its own IndexedDB so
// switching networks can never corrupt another network's channel state.
export interface ReadableStore {
  keys(): Promise<string[]>;
  getItem(key: string): Promise<string | null>;
}
export interface WritableStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export function dbNameForNetwork(network: string): string {
  return `libre-wallet-${network}`;
}

// Copy every key from source into target, but ONLY when the target has no wallet
// yet (no ldk_seed) — never overwrites. Returns the number of keys copied.
export async function migrateStorage(source: ReadableStore, target: WritableStore): Promise<number> {
  if (await target.getItem("ldk_seed")) return 0; // target already a wallet — leave it alone
  const keys = await source.keys();
  let copied = 0;
  for (const k of keys) {
    const v = await source.getItem(k);
    if (v !== null) {
      await target.setItem(k, v);
      copied++;
    }
  }
  return copied;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @libre/example-app exec vitest run src/core/storage-namespace.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/example-app/src/core/storage-namespace.ts packages/example-app/src/core/storage-namespace.test.ts
git commit -m "feat(app): network-scoped DB naming + migrateStorage helper"
```

---

## Task 3: Wire network-scoped storage + migration into `main.ts`

**Files:**
- Modify: `packages/example-app/src/main.ts`

**Interfaces:**
- Consumes: `dbNameForNetwork`, `migrateStorage` (Task 2); `IndexedDBStorageProvider` incl. `keys()` (Task 1).
- Produces: app behavior — network-scoped `storage`, `refreshWalletForNetwork(network)`, one-time `migrateLegacyStorageOnce(network)`, network select disabled while running.

- [ ] **Step 1: Import the helpers**

Add near the other imports (after the existing `ensurePersistentStorage` import):
```ts
import { dbNameForNetwork, migrateStorage } from "./core/storage-namespace";
```

- [ ] **Step 2: Make `storage` network-scoped**

Replace:
```ts
const storage = new IndexedDBStorageProvider();
```
with:
```ts
// Network-scoped: rebuilt by refreshWalletForNetwork() for the selected network.
let storage = new IndexedDBStorageProvider(dbNameForNetwork(networkSelect.value));
```
(`networkSelect` is declared just below today; move this line to AFTER the `const networkSelect = ...` declaration, or convert to a `let` assigned in the init. Simplest: keep `let storage!: IndexedDBStorageProvider;` here and assign it first thing in the init IIFE — see Step 5. Use the `let storage!: IndexedDBStorageProvider;` form to avoid ordering issues.)

Concretely, set at the original location:
```ts
let storage!: IndexedDBStorageProvider; // assigned in the init IIFE via refreshWalletForNetwork
```

- [ ] **Step 3: Add `refreshWalletForNetwork` and `migrateLegacyStorageOnce`**

Add these functions near the init IIFE (above it):
```ts
// Point `storage` at the given network's DB and reflect that wallet in the UI.
// Returns true if that network already has a wallet seed.
async function refreshWalletForNetwork(network: string): Promise<boolean> {
  storage = new IndexedDBStorageProvider(dbNameForNetwork(network));
  const storedSeed = await storage.getItem("ldk_seed");
  if (storedSeed && /^[0-9a-fA-F]{64}$/.test(storedSeed)) {
    seedInput.value = storedSeed;
    restoreBanner.classList.add("hidden");
    return true;
  }
  seedInput.value = "";
  restoreBanner.classList.remove("hidden");
  return false;
}

// One-time copy of the legacy un-namespaced `libre-wallet` DB into the correct
// network-scoped DB. Idempotent (localStorage flag + migrateStorage skips a
// non-empty target). Legacy DB is left intact as a fallback.
async function migrateLegacyStorageOnce(selectedNetwork: string): Promise<void> {
  if (localStorage.getItem("libre_ns_migrated") === "1") return;
  try {
    const legacy = new IndexedDBStorageProvider("libre-wallet");
    const legacySeed = await legacy.getItem("ldk_seed");
    if (legacySeed && /^[0-9a-fA-F]{64}$/.test(legacySeed)) {
      let net = selectedNetwork;
      try {
        const cfg = JSON.parse((await legacy.getItem("ldk_config")) || "{}");
        if (cfg && typeof cfg.network === "string") net = cfg.network;
      } catch {}
      const target = new IndexedDBStorageProvider(dbNameForNetwork(net));
      const copied = await migrateStorage(legacy, target);
      appendLog(
        copied > 0
          ? `[SYSTEM] Migrated existing wallet into network storage (libre-wallet-${net}, ${copied} keys).`
          : `[SYSTEM] Existing wallet already present in network storage (libre-wallet-${net}).`,
        "system"
      );
    }
  } catch (e) {
    appendLog(`[WARN] Storage migration skipped: ${e instanceof Error ? e.message : e}`, "warn");
  } finally {
    localStorage.setItem("libre_ns_migrated", "1");
  }
}
```

- [ ] **Step 4: Rebuild storage on network change (guarded)**

In the `networkSelect` change handler, append (after it sets the presets and saves `libre_ui_network`):
```ts
  // Network determines which wallet DB we use — switching needs a stopped node.
  if (isNodeRunning) {
    appendLog("[ERROR] Stop the node before switching networks.", "error");
    return;
  }
  void refreshWalletForNetwork(networkSelect.value);
```
(Place the `isNodeRunning` check at the TOP of the handler instead if simpler, before mutating fields — either is acceptable as long as a running node is not allowed to switch.)

- [ ] **Step 5: Run migration + network-scoped restore in the init IIFE**

In the init IIFE, REPLACE the existing seed-restore block:
```ts
  let hasWallet = false;
  try {
    const storedSeed = await storage.getItem("ldk_seed");
    if (storedSeed && /^[0-9a-fA-F]{64}$/.test(storedSeed)) {
      seedInput.value = storedSeed;
      restoreBanner.classList.add("hidden");
      appendLog("[SYSTEM] Restored existing wallet seed and network from storage.", "system");
      hasWallet = true;
    } else {
      restoreBanner.classList.remove("hidden");
    }
  } catch {}
```
with:
```ts
  const selectedNetwork = networkSelect.value;
  await migrateLegacyStorageOnce(selectedNetwork);
  const hasWallet = await refreshWalletForNetwork(selectedNetwork);
  if (hasWallet) {
    appendLog("[SYSTEM] Restored existing wallet seed and network from storage.", "system");
  }
```

- [ ] **Step 6: Disable the network selector while the node runs**

In the start-success path (where `stopNodeBtn.disabled = false;` etc. are set) add:
```ts
    networkSelect.disabled = true;
```
In the stop handler (where `startNodeBtn.disabled = false;` etc. are set) add:
```ts
    networkSelect.disabled = false;
```

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @libre/example-app exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Build**

Run: `pnpm --filter @libre/listener-wallet build && pnpm --filter @libre/example-app build`
Expected: both succeed (SDK rebuilt so the app sees `keys()` in the types).

- [ ] **Step 9: Commit**

```bash
git add packages/example-app/src/main.ts
git commit -m "feat(app): per-network IndexedDB + one-time legacy migration + guarded network switch"
```

---

## Task 4: Full verification + manual smoke

- [ ] **Step 1: Full test suite**

Run: `pnpm test`
Expected: all packages PASS (SDK incl. new IDB tests; app incl. storage-namespace + persistent-storage).

- [ ] **Step 2: Manual smoke (normal browser window)**

1. `docker compose up -d` (for regtest) and `pnpm --filter @libre/example-app dev`.
2. Open `http://localhost:5173/` in a normal window. **Migration:** if this profile already had a `libre-wallet` wallet, the log shows `Migrated existing wallet into network storage (libre-wallet-<net>, N keys)` once; reload shows no second migration line.
3. On **regtest**, create a wallet, Start. In DevTools → Application → IndexedDB, confirm a **`libre-wallet-regtest`** DB exists with the keys.
4. Stop the node, switch the network selector to **signet** → seed field clears / restore banner shows (a *different*, empty wallet); confirm a separate `libre-wallet-signet` DB. Switch back to **regtest** → the regtest wallet/seed returns.
5. With the node **running**, confirm the network selector is **disabled** (can't switch mid-run).
6. Reload on regtest → `Restored existing wallet seed…` and (if auto-start on) it boots the regtest wallet. The mainnet/signet DBs are untouched.

- [ ] **Step 3: Confirm with the human, then merge only on approval**

Do not merge to `master` without approval. When approved, follow `superpowers:finishing-a-development-branch`.

---

## Notes for the implementer
- Line numbers shift as you edit; locate by symbol (`new IndexedDBStorageProvider`, `networkSelect.addEventListener`, the init IIFE, the start/stop handlers).
- Keep the SDK free of `navigator`/`window`. All DB-name/migration logic stays in the app.
- The legacy `libre-wallet` DB is intentionally NOT deleted.
