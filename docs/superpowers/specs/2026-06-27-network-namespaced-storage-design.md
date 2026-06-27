# Network-Namespaced Wallet Storage — Design

- **Date:** 2026-06-27
- **Status:** Approved (pending spec review)
- **Scope:** `@libre/example-app` (network-scoped storage + migration) + one additive method on `@libre/listener-wallet`'s `IndexedDBStorageProvider`.

## 1. Background / Why

Wallet storage is **not namespaced by network**. The injected `IndexedDBStorageProvider` uses a single DB (`libre-wallet`), so `ldk_seed`, `channel_manager`, channel monitors, `network_graph`, `scorer`, `state_version`, `preimage_*`, `rgs_timestamp`, and `ldk_config` are **shared across networks**. Using one browser profile across regtest and mainnet **overwrites/corrupts channel state** (documented symptom: `Loaded 0 channel monitors` + a `ChannelManager` from the wrong chain). This is the same class of footgun that motivated the backup work, and it must be fixed before funding a mainnet wallet that is also used for regtest/signet testing.

## 2. Goals / Non-Goals

**Goals**
- Each Bitcoin network gets fully isolated storage — switching networks can never corrupt another network's wallet.
- Existing un-namespaced wallets keep working with no manual action (auto-migration).
- No data loss; migration never overwrites and leaves the legacy DB intact as a fallback.

**Non-Goals**
- Sharing one seed across networks (each network is an independent wallet, by design).
- Extracting a reusable cross-app helper (v4vmusic et al.) — noted as a follow-up; this spec stays in the example app.
- Changing the SDK's storage keying or the `SecureStorageProvider` interface.

## 3. Approach

Namespacing is **app-layer**: the storage DB name becomes `libre-wallet-${network}` (`mainnet` | `testnet` | `regtest` | `signet`). The SDK keeps writing the same bare keys; isolation comes entirely from which DB the injected provider points at. Each network ⇒ independent wallet (own seed + channel state).

## 4. SDK change (additive only)

`packages/libre-listener-wallet/src/indexed-db-storage.ts`:
- Add `keys(): Promise<string[]>` returning all keys in the store (via IndexedDB `getAllKeys`). Needed so migration can copy **every** key, including `preimage_*` (which are not tracked in `ldk_keys_index`).
- The `SecureStorageProvider` interface is unchanged; this is a concrete-class addition. No other SDK logic changes.

## 5. App changes (`packages/example-app/src/main.ts` + new `core/storage-namespace.ts`)

### 5.1 `core/storage-namespace.ts` (new, testable)
```ts
export type Network = "mainnet" | "testnet" | "regtest" | "signet";
export function dbNameForNetwork(network: string): string {
  return `libre-wallet-${network}`;
}
// Source needs keys()+getItem; target needs getItem+setItem. Copies every key
// ONLY when the target is empty (never overwrites). Returns count copied.
export interface ReadableStore { keys(): Promise<string[]>; getItem(k: string): Promise<string | null>; }
export interface WritableStore { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void>; }
export async function migrateStorage(source: ReadableStore, target: WritableStore): Promise<number> { /* ... */ }
```
`migrateStorage` returns 0 (no-op) when the target already has an `ldk_seed` (treat as non-empty). Otherwise copies all source keys to target and returns the count.

### 5.2 `main.ts` wiring
- Replace the module-level `const storage = new IndexedDBStorageProvider()` with a `let storage` built for the active network via `dbNameForNetwork`.
- `refreshWalletForNetwork(network)`: rebuild `storage` for that network's DB, then repopulate the seed field from it (or show the restore banner if empty). Used by both the load sequence and the network-selector change handler.
- **Network selector change:** if `isNodeRunning`, refuse with a clear message ("Stop the node before switching networks"); otherwise call `refreshWalletForNetwork(newNetwork)`.
- **Load sequence** (in the existing init IIFE), in order:
  1. Resolve the selected network (persisted selection, default `regtest` as today).
  2. Run one-time migration (5.3).
  3. `refreshWalletForNetwork(network)` → builds `storage`, restores seed.
  4. Existing auto-start / Drive auto-connect logic.

### 5.3 Migration (one-time, idempotent)
```
if localStorage["libre_ns_migrated"] !== "1":
  legacy = new IndexedDBStorageProvider("libre-wallet")
  if await legacy.getItem("ldk_seed"):
    cfg = JSON.parse(await legacy.getItem("ldk_config") || "{}")
    net = cfg.network ?? persistedSelectedNetwork ?? networkSelect.value
    target = new IndexedDBStorageProvider(dbNameForNetwork(net))
    copied = await migrateStorage(legacy, target)   // skips if target already has a seed
    log "[SYSTEM] Migrated existing wallet → libre-wallet-<net> (N keys)" (or "already present")
  localStorage["libre_ns_migrated"] = "1"
```
Legacy `libre-wallet` DB is **not** deleted (fallback). Migration runs before any storage read so the restored wallet is found in the namespaced DB.

## 6. Data Flow

- **Fresh load:** resolve network → migrate (once) → build `libre-wallet-<net>` storage → restore seed → auto-start.
- **Switch network (node stopped):** rebuild storage for the new DB → seed field reflects that network's wallet (or restore banner).
- **Create/restore/start:** unchanged handlers, now operating on the network-scoped `storage`.

## 7. Error Handling

- Migration is best-effort and wrapped: any failure logs a `[WARN]` and does not block load (the user can still restore from backup). The `libre_ns_migrated` flag is only set after the attempt completes so a hard crash mid-migrate retries next load (idempotent because `migrateStorage` skips a non-empty target).
- Network switch while running: explicit `[ERROR]`, no storage rebuild.

## 8. Testing (TDD; no LDK mocking)

- **`migrateStorage` unit tests** (Map-backed `ReadableStore`/`WritableStore` doubles, no IndexedDB): copies all keys incl. a `preimage_*` key; returns the count; **skips when target already has `ldk_seed`** (idempotent / no overwrite); empty source → 0.
- **`IndexedDBStorageProvider` tests** via `fake-indexeddb` (new devDep, `import "fake-indexeddb/auto"`): `set`/`get`/`remove`/`clear`/`keys` round-trip; **two different DB names are isolated** (writing to `libre-wallet-regtest` is invisible to `libre-wallet-mainnet`).
- **`dbNameForNetwork`**: returns `libre-wallet-<network>` for each network.

## 9. Scope

**In:** `IndexedDBStorageProvider.keys()`; `core/storage-namespace.ts`; `main.ts` network-scoped storage + migration + guarded network switch.
**Out (follow-up spec):** a shared SDK helper so other apps (v4vmusic.com) namespace + migrate identically without re-implementing.

## 10. Open Questions

None. (Per-network DB confirmed; independent per-network seed confirmed; auto-migrate confirmed; `fake-indexeddb` test dep approved; network switch requires Stop confirmed.)
