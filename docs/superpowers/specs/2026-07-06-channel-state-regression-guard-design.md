# Channel-State Regression Guard (Layer A)

**Date:** 2026-07-06
**Status:** Design — approved for planning
**Package:** `@libre/listener-wallet` (`packages/libre-listener-wallet/src/index.ts`)

## Motivation

On 2026-07-06 a funded mainnet test channel was **force-closed** by the counterparty (lnd) after the browser-extension wallet reconnected advertising a `channel_reestablish` at genesis state (`remote believes our tail height is 0, while we have 180`). The channel had really advanced to commitment height 180. lnd's BOLT2 data-loss protection correctly force-closed to protect funds.

Root cause class: the extension hosts the LDK node in an MV3 **offscreen document that Chrome terminates abruptly**, and persistence acks LDK *optimistically* (before the IndexedDB commit lands). A lost write leaves the node able to reload **stale channel state** and reconnect, which the peer force-closes. Full context: the `extension-offscreen-persistence-forceclose` memory + `CLAUDE.md` "force-close-from-missing-state" gotcha.

This spec covers **Layer A** of a three-layer defense (see "Scope & non-goals"). Layer A is the **unconditional guarantee**: a node whose loaded channel state has regressed below a point it durably reached must **refuse to reconnect** (halt) rather than reestablish a stale state. A halted wallet is always recoverable via restore; a force-closed channel is not.

## Goal

Eliminate the **self-inflicted, data-loss** force-close: whenever the node loads channel state that is behind a durably-recorded high-water mark, it must throw during `start()` (before any peer connection) and surface a "restore from backup" condition — never connect and reestablish stale state.

Non-goal: preventing a counterparty from force-closing for its own reasons (HTLC timeouts, their policy). That is what the on-chain sweep address is for.

## Design

### Signal: the monitor's latest update id (not `state_version`)

`state_version` (`index.ts:397, 900`) is persisted as an **independent sidecar key**, decoupled from the `channel_manager`/monitor blobs. If the large `channel_manager` write is lost while the tiny `state_version` write survives, a `state_version`-based check reads "current" while the channel is actually stale — a blind spot. Rejected.

Instead the guard keys off the **`ChannelMonitor` latest update id**, which is coupled to the real, safety-critical channel state:

- `ChannelMonitor.get_latest_update_id(): bigint` — monotonic per-channel counter, increments on every monitor update. Verified present in `lightningdevkit@0.1.0` bindings.
- `ChannelMonitor.channel_id()` — hex key for the per-channel high-water map. Verified present.

### Persisted marker

New non-critical storage key **`monitor_update_highwater`**: a JSON map `{ [channelIdHex: string]: string /* latestUpdateId as decimal */ }`, monotonic per channel (a value never decreases). Stored via the existing injected `storage` (same `IndexedDBStorageProvider`); **not** part of the encrypted backup and **not** a storage-contract invariant (it is re-derivable and its absence is handled — see Compatibility).

### Advancing the high-water mark (during operation)

In the existing event-tick loop (`index.ts:797`, the `eventTickIntervalId` interval), after processing events, read each live monitor's `get_latest_update_id()` keyed by `channel_id()` and persist `highwater[id] = max(stored, live)`. This tracks the latest update ids the running node has reached. Advancing is best-effort and monotonic (write is fire-and-forget with a logged `.catch`, matching the surrounding persist calls).

### The guard (on load)

In `start()`, at the point monitors are read and registered (`index.ts:492–509`, `read_all_channel_monitors_with_updates()` → `channelMonitors`), **before** the background loops and peer connection are set up:

1. Load the persisted `monitor_update_highwater` map (absent → empty map).
2. For each loaded monitor: `loadedId = monitor.get_latest_update_id()`, `key = channel_id` hex.
3. If `highwater[key]` exists and `loadedId < highwater[key]` for **any** channel → **throw** a `ChannelStateRegressionError` (new exported error subclass) with a clear message: the channel state on disk is behind a point this wallet durably reached; refuse to start to avoid force-closing the channel; restore from a backup. Mirror the existing decode-failure guard (`index.ts:630–634`) which already throws to prevent this class of force-close.
4. Otherwise (all monitors ≥ their recorded high-water, or no entry): proceed, and immediately advance/initialize `highwater[key] = max(stored, loadedId)` and persist.

The throw happens **before** `PeerManager`/reconnect setup, so a regressed node never dials a peer and never emits a stale `channel_reestablish`.

### Restore & fresh-wallet interactions

- **`importState` (restore):** after writing channel state, set `monitor_update_highwater` to the restored monitors' `get_latest_update_id()` values (max with any existing). A restore is authoritative — it must clear any stale high-water from a prior wallet so it can't false-halt.
- **Fresh/brand-new wallet** (no monitors): map is empty; nothing to compare; the guard is a no-op. Consistent with the existing "created-new" provenance path.

## Behavior matrix

| Situation | loaded id vs highwater | Action |
|---|---|---|
| Normal reload (state intact) | equal | start normally |
| Catastrophic rollback (snapshot/DB confusion → genesis) | loaded ≪ highwater | **HALT → restore prompt** (this is the incident) |
| Lost the last few writes symmetrically (peer also behind) | equal (both lost together) | start normally (residual — Layer C closes) |
| Highwater advanced but monitor write lost | loaded < highwater | HALT (conservative, safe) |
| Legacy wallet, no marker yet | no entry | start, initialize marker |
| Restore from backup | reset to restored id | start normally |

The guard is deliberately biased toward **halting** (safe) over reconnecting (risks force-close). A false halt costs availability (user restores from backup); it never costs a channel.

## Scope & non-goals

This is **Layer A** of three; each is a separate spec → plan → implement cycle:

- **Layer A (this spec):** regression guard — the guarantee. Halt instead of reconnecting when state regressed.
- **Layer B (later):** reduce the trigger in the extension — keep the offscreen node alive while a channel is live; flush and await pending persistence on `freeze`/`pagehide`.
- **Layer C (later):** eliminate the cause — LDK async-persistence contract (`ChannelMonitorUpdateStatus::InProgress` → `channel_monitor_updated()`) so the node never advances channel state until the IndexedDB commit is durable. Gated on confirming the WASM binding exposes `channel_monitor_updated`.

Non-goals for Layer A: the async-persistence rewrite (C), the offscreen keep-alive (B), the separate `channel_manager`-persist-bypasses-`StorageCache` cleanup (`index.ts:804`), and the endless "Catch-up confirmed 1 buried tx(s)" re-confirmation noise. Tracked separately.

## Testing (TDD, real LDK WASM — no LDK mocking)

Unit tests in `packages/libre-listener-wallet/src/tests/unit/` (jsdom, no docker):

1. **Halts on regression:** start a wallet with a persisted `monitor_update_highwater` above the loaded monitor's `get_latest_update_id()` → `start()` throws `ChannelStateRegressionError`; assert no peer connection attempt was made.
2. **Starts normally when current:** highwater == loaded id → `start()` succeeds; marker advances.
3. **Legacy/no marker:** no `monitor_update_highwater` key → starts; marker initialized to loaded id.
4. **Advances during operation:** after a monitor update + event tick, `monitor_update_highwater` reflects the new latest update id.
5. **Restore resets marker:** `importState` sets the marker to the restored monitors' ids so a stale prior high-water does not false-halt.
6. **Marker is not a backup/contract invariant:** `exportState` does not include `monitor_update_highwater`; storage-contract tests remain green.

Assert **outcomes** (throw vs. started, no-dial, persisted marker values), not call order.

## Files touched

- `packages/libre-listener-wallet/src/index.ts` — guard in the monitor-load section; high-water advance in the event-tick loop; `importState` marker reset; export `ChannelStateRegressionError`.
- New small helper (pure) for the high-water compare/merge logic, e.g. `packages/libre-listener-wallet/src/state-highwater.ts` — `parseHighwater`, `mergeHighwater`, `findRegression(loaded, stored)` — unit-testable without WASM.
- `packages/libre-listener-wallet/src/tests/unit/state-regression-guard.test.ts` (WASM) + `state-highwater.test.ts` (pure).
- Barrel export of `ChannelStateRegressionError` from `index.ts`.

## Risks

- **False halts** if the high-water advances ahead of durable monitor state. Mitigation: bias is intentional and safe; Layer B/C reduce the frequency of the underlying loss. Documented for the extension/PWA host so the UI shows a clear restore path rather than a generic error.
- **Marker corruption** (bad JSON): `parseHighwater` returns an empty map on parse failure (no-op guard, logged) rather than throwing — never block startup on a corrupt *non-critical* marker.
- The guard runs only at load/reconnect (the sole vector for the data-loss reestablish force-close); a node that never restarts cannot hit this path.
