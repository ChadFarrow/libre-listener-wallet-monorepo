# Layer C — Durable-Before-Advance Persistence

**Date:** 2026-07-06
**Status:** Design — approved for planning
**Package:** `@libre/listener-wallet` (`packages/libre-listener-wallet/src/`)

## Motivation

The 2026-07-06 mainnet force-close (and a recurrence) trace to one root cause: the node advances channel state on **optimistically-acked** persistence. `StorageCache` (a `KVStore`) synchronously tells LDK a write succeeded, then fires the real IndexedDB commit asynchronously. When the extension's MV3 offscreen document is **abruptly terminated** mid-commit, the write is lost — and because LDK already got its "ok", it had advanced past state that never durably landed. On reload the node is behind, reconnects with a stale `channel_reestablish`, and the peer force-closes.

**Layer A** (shipped, PR #17) turns that regression into a safe halt. **Layer B** (separate) keeps the offscreen node alive to reduce kills. **Layer C (this spec) eliminates the cause:** the node must never advance channel state until the write is **durably committed**.

## Goal

Adopt LDK's asynchronous-persistence contract so a monitor update is treated as applied only after its IndexedDB commit lands. Concretely: the monitor `Persist` returns `ChannelMonitorUpdateStatus::InProgress`, and `ChainMonitor.channel_monitor_updated(funding_txo, update_id)` is called only after the durable commit — so LDK will not send `commitment_signed` / advance the channel until then. An abrupt kill before the commit means LDK never advanced past it → on reload, disk and LDK agree → no regression.

Non-goal: changing the on-disk monitor format, migrating funded wallets, or altering the backup/storage contract. This change is signalling-only.

## Confirmed binding surface (lightningdevkit@0.1.0 WASM)

- `Persist.new_impl(PersistInterface)` — custom persister from JS. ✓
- `Persist.persist_new_channel(txo, monitor): ChannelMonitorUpdateStatus` and `update_persisted_channel(txo, monitor_update, monitor): ChannelMonitorUpdateStatus` — callable on the inner persister. ✓
- `ChainMonitor.channel_monitor_updated(funding_txo: OutPoint, completed_update_id: bigint): Result_NoneAPIErrorZ`. ✓
- `ChannelMonitorUpdate.get_update_id(): bigint`; `ChannelMonitor.get_latest_update_id(): bigint`. ✓
- `ChannelMonitorUpdateStatus` enum (InProgress / Completed / UnrecoverableError). The exact JS accessor for the `InProgress` variant is verified during the POC (step 1).

Docs (Persist trait): *"It is only necessary to call `ChainMonitor::channel_monitor_updated` when you return `ChannelMonitorUpdateStatus::InProgress`."*

## Design (Approach A — wrap the existing persister)

Keep `MonitorUpdatingPersister` for serialization/read (unchanged format), and insert a thin durability layer.

### 1. `StorageCache.flush(): Promise<void>`
Resolve when every outstanding async IndexedDB commit issued so far has durably landed; reject if any failed (reuses the existing degraded-state tracking). Implementation: `StorageCache` retains the in-flight `setItem`/`removeItem` promises; `flush()` awaits them (e.g. `Promise.all` of the current outstanding set). One new method; no format change.

### 2. `DurablePersist` (new file `durable-persist.ts`)
A `Persist` built via `Persist.new_impl`, constructed with: the inner `MonitorUpdatingPersister.as_Persist()`, the `StorageCache`, a late-bound `getChainMonitor()` accessor (the `ChainMonitor` is built *with* this persister, so the reference is set after construction), and the injected `Logger`.

- `persist_new_channel(txo, monitor)`:
  1. `inner.persist_new_channel(txo, monitor)` — performs the real KVStore write through `StorageCache` (cache updated, async commit fired).
  2. `updateId = monitor.get_latest_update_id()`.
  3. Schedule durability signal: `storageCache.flush().then(() => getChainMonitor().channel_monitor_updated(txo, updateId), (err) => log + leave paused)`.
  4. **return `InProgress`.**
- `update_persisted_channel(txo, monitor_update, monitor)`: same, but `updateId = monitor_update ? monitor_update.get_update_id() : monitor.get_latest_update_id()`. Return `InProgress`.
- `archive_persisted_channel(txo)`: delegate to `inner`.

**Ordering:** because `flush()` waits for *all* outstanding writes, once it resolves for update N every write ≤ N is durable — so `channel_monitor_updated(txo, N)` (which marks everything up to N complete) is always sound without per-key bookkeeping. Signalling is naturally monotonic.

**Failure:** if `flush()` rejects, do **not** call `channel_monitor_updated` — LDK stays paused on that channel. Combined with the existing `StorageCache` degraded state (which then `IOError`s further writes), the node stops advancing on storage it can't trust.

### 3. Wiring (`index.ts`)
Replace `const monitorPersister = this.monitorUpdatingPersister.as_Persist()` with a `DurablePersist` wrapping it; pass a `() => this.chainMonitor` accessor (set right after `ChainMonitor.constructor_new`). Everything else (monitor read/registration, `ChannelManager::read`) is unchanged.

### 4. Startup reconciliation
On restart, LDK loads monitors and the manager; any update that was persisted-but-not-signalled (killed before `flush`) is simply state LDK never advanced past — disk and manager are consistent. The POC (step 1) validates LDK's on-load handling of channels whose last persist returned `InProgress`, and whether any `channel_monitor_updated` replay is required at startup; the plan encodes whatever the POC proves.

## The primary risk → POC first

The design is correct per the LDK docs, but the **0.1.0 WASM binding behaviour must be proven** before the full change: (a) does returning `InProgress` actually pause the `ChannelManager` (no `commitment_signed` until `channel_monitor_updated`), and (b) does startup reconcile cleanly? **Plan step 1 is a minimal proof-of-concept** (a focused regtest test: open a channel with `DurablePersist`, drive one update, assert LDK waits for `channel_monitor_updated`; restart and assert clean resume). If the binding does not honour `InProgress`, we stop and reassess before touching the live path.

## Scope & non-goals

- In scope: `StorageCache.flush()`, `DurablePersist`, the one-line `index.ts` wiring, POC + tests.
- Out of scope: on-disk format changes, migrations, storage-contract changes, Layer B (offscreen keep-alive), the extension UI. No changes to the backup path.

## Testing (TDD, real LDK WASM — no LDK mocking)

- **Unit:** `StorageCache.flush()` — resolves after pending commits, rejects on a failed commit, interacts correctly with the degraded flag. `DurablePersist` status/signal logic driven with real LDK monitor objects where feasible (the pure parts — update-id selection, the flush→signal wiring — unit-tested; no mocked LDK internals).
- **Integration (docker regtest):** (1) the POC test above; (2) the durability proof — open a funded channel, make a payment, **simulate an abrupt kill by withholding `channel_monitor_updated`** (drop the signal), restart, assert the node resumes with no regression, the channel is intact, and payments still work; (3) confirm the Layer A guard does **not** fire in normal operation (no false halts introduced).
- Full: lint 0 errors, `check:storage` green (format unchanged), existing SDK suites green.

## Rollout

Layer C ships as its own PR (branch `layer-c-durable-persistence`), independent of Layer B. Because the format is unchanged, existing funded/restored wallets are unaffected on upgrade.
