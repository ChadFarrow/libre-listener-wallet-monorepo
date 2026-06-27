# Esplora Buried-Confirmation Fix — Design

- **Date:** 2026-06-27
- **Status:** Approved (pending spec review)
- **Scope:** `packages/libre-listener-wallet/src/esplora-client.ts` — make channel funding txs confirm even when their block was already synced.

## 1. Background / Why

Browser-LDK channels open + fund on-chain (lnd shows them confirmed), but the listener wallet keeps them **"pending" forever** (`isChannelReady=false`), never sends its own `channel_ready`, so lnd's link stays `active:false` and payments fail with `FAILURE_REASON_INSUFFICIENT_BALANCE`. This blocks all send/receive — the real "usable wallet" gap. Confirmed live: 4 regtest channels stuck pending; `lncli payinvoice` of a listener invoice failed `INSUFFICIENT_BALANCE`.

**Root cause:** `sync()` walks blocks `bestHeight+1 → tip` and only calls `transactions_confirmed` for a watched tx when its `block_height === currentHeight` *inside that forward window*. A funding tx that becomes registered (via `register_tx`) **after** its confirming block was already synced — or whose block is `≤ bestHeight` — is never confirmed. The LSPS2 server mines 6 blocks instantly after opening, so by the time the browser node registers the funding outpoint the blocks are already synced → missed.

**Network-agnostic.** Same bug bites mainnet via the PWA restart race: open channel → close app/tab → funding confirms while away → reopen → node syncs straight to tip (past the funding block) → registered funding tx is `≤ bestHeight` → never confirmed → stuck pending. Fixing this de-risks the eventual mainnet test.

`sync()` already runs every 30s (a `setInterval` in `index.ts`), so the fix auto-runs and recovers already-stuck channels on the next tick — no new scheduling needed.

## 2. Goals / Non-Goals

**Goals**
- Confirm watched/registered txs whose confirming block is at/below `bestHeight`, at their real height, independent of the forward-sync cursor.
- Recover already-stuck channels on the next sync; prevent the bug on regtest and the mainnet restart race.
- Keep it testable: a pure planner with unit tests + one regtest integration test reproducing the race.

**Non-Goals**
- Rewriting `sync()` to ldk-node's full algorithm.
- Changing the reorg path or the forward-loop confirmation for blocks `> bestHeight`.
- Any non-funding flow, fee logic, or other package.

## 3. The fix (in `sync()`, after the reorg check, before the forward loop)

A **catch-up confirmation pass**:

1. **Build the watched set** (unconfirmed txs LDK cares about):
   - For each tuple in `confirmManager.get_relevant_txids()` + `confirmMonitor.get_relevant_txids()` (type `ThreeTuple_ThirtyTwoBytesu32COption_ThirtyTwoBytesZZ`: `get_a()`=txid bytes, `get_b()`=height, `get_c()`=`Option_ThirtyTwoBytesZ`), include `bytesToHex(get_a())` **iff** `get_c()` is **not** `Option_ThirtyTwoBytesZ_Some` (i.e. LDK still considers it unconfirmed).
   - Plus every key in `this.registeredTxs` (funding txs registered via the Filter).
2. **Plan** which are buried-confirmed via the pure helper `planBuriedConfirmations(watchedTxids, fetchStatus, bestHeight)` (§4): keep txs `confirmed` at `block_height ≤ bestHeight`, group by height, return ascending-height groups.
3. **Apply**: for each group (ascending height), fetch the block header (`fetchBlockHeader(height)`), fetch each tx's raw bytes (`fetchRawTx`) + merkle position (`fetchMerkleProof`), sort the group's txs by `pos`, build `TwoTuple_usizeTransactionZ[]`, and call `transactions_confirmed(header, txdata, height)` on **both** `confirmManager` and `confirmMonitor`.

The forward loop (blocks `> bestHeight`) runs unchanged afterward, so confirmation calls stay in ascending height order overall and `best_block_updated` still advances to tip. When `bestHeight === tip` (common, already caught up) the catch-up still confirms the buried funding and LDK marks the channel ready (confs = `tip − fundingHeight + 1 ≥ min_depth`).

## 4. Testability refactor

Extract a **pure** function (module-level, exported):

```ts
// Decides which watched txs are buried-confirmed (block_height <= bestHeight) and groups them
// by height ascending, so the caller can confirm them in chain order.
export async function planBuriedConfirmations(
  watchedTxids: string[],
  fetchStatus: (txid: string) => Promise<{ confirmed: boolean; block_height?: number } | null>,
  bestHeight: number,
): Promise<{ height: number; txids: string[] }[]>
```

- Skips txids whose status is null / unconfirmed / `block_height > bestHeight`.
- Groups remaining by `block_height`; returns groups sorted by height ascending (txids within a group in input order; final pos-sorting happens in `sync()` where merkle proofs are fetched).
- No LDK, no direct network — `fetchStatus` is injected (in `sync()` it wraps `this.fetchTx`).

`sync()` builds `watchedTxids` from LDK + `registeredTxs`, calls `planBuriedConfirmations(..., (t) => this.fetchTx(t).then(tx => tx?.status ?? null), bestHeight)`, then does the header/rawtx/merkle fetch + `transactions_confirmed` wiring per group.

## 5. Error handling

- Per-tx esplora fetch errors inside the catch-up pass are caught, logged via the injected `logger.warn`, and that tx is skipped (retried on the next 30s sync). The pass never throws out of `sync()`.
- `planBuriedConfirmations` treats a `null` from `fetchStatus` as "skip" (already the contract), so a failed fetch can't crash planning.

## 6. Testing (TDD; no mocking LDK internals)

- **Unit — `planBuriedConfirmations` (node env, no docker, fast) — the automated guard:**
  - Includes a tx confirmed at `block_height === bestHeight` and one `< bestHeight`; groups them by height ascending.
  - Excludes: unconfirmed (`confirmed:false`), `null` status, and `block_height > bestHeight`.
  - Multiple txs in the same block → one group with both txids.
  - Returns `[]` for empty input.
  - Covers the full decision logic of the fix (which txs confirm, grouping, ordering).
- **Live verification (real stack, concrete) — replaces an automated integration test.** A deterministic automated test for the race is impractical: it depends on the funding block being synced *before* the tx is registered, which would require invasively rewriting the wallet's persisted best block. Instead we already have the exact failure set up — **4 regtest channels stuck `pending`/`active:false`** with a payment that failed `INSUFFICIENT_BALANCE`. Verification: build the SDK, hard-reload the app on regtest; within ~30s (one sync tick) the stuck channels flip to **active** in the balance/channel view, then `lncli payinvoice` of a fresh listener invoice **settles**. This proves the fix on the real bug, end-to-end.

## 7. Scope summary

**In:** catch-up confirmation pass in `sync()`; exported pure `planBuriedConfirmations`; unit tests for it; live verification on the existing stuck channels.
**Out:** full sync rewrite, reorg-path changes, forward-loop changes, an automated integration test for the race (impractical — see §6), other packages.
