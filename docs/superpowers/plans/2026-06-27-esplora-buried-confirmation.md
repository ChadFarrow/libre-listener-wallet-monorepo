# Esplora Buried-Confirmation Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confirm channel funding txs whose block was already synced, so browser-LDK channels stop being stuck "pending" and can send/receive.

**Architecture:** Add a catch-up pass to `EsploraSyncClient.sync()` that confirms watched/registered txs buried at/below `bestHeight` (the forward loop only covers `> bestHeight`). The decision logic is a pure exported `planBuriedConfirmations`; `sync()` does the LDK `transactions_confirmed` wiring per height group.

**Tech Stack:** TypeScript, LDK WASM (`lightningdevkit` 0.1.0), Vitest (node env), pnpm + Turborepo.

## Global Constraints

- pnpm@10.10.0; SDK stays platform-free (no `window`/`fs`); TDD; files kebab-case / types PascalCase / functions camelCase.
- No silent catches — log via the injected `logger` and skip (repo guardrail).
- LDK 0.1.0: `get_relevant_txids()` → `ThreeTuple_ThirtyTwoBytesu32COption_ThirtyTwoBytesZZ[]` (`get_a()`=txid `Uint8Array`, `get_c()`=`Option_ThirtyTwoBytesZ`; `_Some` ⇒ LDK considers it confirmed). Already imported in the file: `Option_ThirtyTwoBytesZ_Some`, `TwoTuple_usizeTransactionZ`; helpers `bytesToHex`/`hexToBytes`.
- `fetchTx(txid)` → `EsploraTx | null` with `.status: { confirmed: boolean; block_height?: number }`; `fetchBlockHeader(h)` → hex; `fetchRawTx(txid)` → hex; `fetchMerkleProof(txid)` → `{ pos: number } | null`.
- The catch-up pass handles confirmation height **≤ bestHeight only**; the existing forward loop keeps handling `> bestHeight` (no overlap, no double-confirm).
- Never commit to `master`; feature branch; no push without approval.

---

## File Structure

- `packages/libre-listener-wallet/src/esplora-client.ts` — add exported `planBuriedConfirmations`; add the catch-up pass to `sync()`.
- `packages/libre-listener-wallet/src/tests/unit/esplora-confirm.test.ts` — create; unit tests for `planBuriedConfirmations`.

---

## Task 0: Feature branch

- [ ] **Step 1: Branch**

```bash
cd /Users/chad-mini/Vibe/libre-listener-wallet-monorepo
git checkout -b fix/esplora-buried-confirmation
```

---

## Task 1: Pure `planBuriedConfirmations` + unit tests

**Files:**
- Modify: `packages/libre-listener-wallet/src/esplora-client.ts`
- Test: `packages/libre-listener-wallet/src/tests/unit/esplora-confirm.test.ts` (create)

**Interfaces:**
- Produces: `export async function planBuriedConfirmations(watchedTxids: string[], fetchStatus: (txid: string) => Promise<{ confirmed: boolean; block_height?: number } | null>, bestHeight: number): Promise<{ height: number; txids: string[] }[]>`

- [ ] **Step 1: Write the failing test**

Create `packages/libre-listener-wallet/src/tests/unit/esplora-confirm.test.ts`:
```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { planBuriedConfirmations } from "../../esplora-client";

type Status = { confirmed: boolean; block_height?: number } | null;
const from = (m: Record<string, Status>) => async (txid: string): Promise<Status> => m[txid] ?? null;

describe("planBuriedConfirmations", () => {
  it("groups buried-confirmed txs by ascending height", async () => {
    const r = await planBuriedConfirmations(
      ["a", "b"],
      from({ a: { confirmed: true, block_height: 100 }, b: { confirmed: true, block_height: 95 } }),
      100,
    );
    expect(r).toEqual([{ height: 95, txids: ["b"] }, { height: 100, txids: ["a"] }]);
  });

  it("excludes unconfirmed, null/missing, and block_height > bestHeight", async () => {
    const r = await planBuriedConfirmations(
      ["unconf", "future", "ok", "missing"],
      from({
        unconf: { confirmed: false },
        future: { confirmed: true, block_height: 101 },
        ok: { confirmed: true, block_height: 50 },
      }),
      100,
    );
    expect(r).toEqual([{ height: 50, txids: ["ok"] }]);
  });

  it("groups multiple txs confirmed in the same block", async () => {
    const r = await planBuriedConfirmations(
      ["x", "y"],
      from({ x: { confirmed: true, block_height: 80 }, y: { confirmed: true, block_height: 80 } }),
      100,
    );
    expect(r).toEqual([{ height: 80, txids: ["x", "y"] }]);
  });

  it("returns [] for empty input", async () => {
    expect(await planBuriedConfirmations([], async () => null, 100)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run → fail**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/esplora-confirm.test.ts`
Expected: FAIL — `planBuriedConfirmations` is not exported.

- [ ] **Step 3: Implement the pure helper**

In `packages/libre-listener-wallet/src/esplora-client.ts`, add at module level (e.g. just above `export class EsploraSyncClient`):
```ts
// Decide which watched txs are "buried" — confirmed on-chain at a height the forward
// sync loop won't revisit (block_height <= bestHeight) — and group them by height
// ascending so the caller can confirm them in chain order. Pure; no LDK, no direct network.
// `fetchStatus` returns null for fetch errors/missing txs (caller logs); null = skip.
export async function planBuriedConfirmations(
  watchedTxids: string[],
  fetchStatus: (txid: string) => Promise<{ confirmed: boolean; block_height?: number } | null>,
  bestHeight: number,
): Promise<{ height: number; txids: string[] }[]> {
  const byHeight = new Map<number, string[]>();
  for (const txid of watchedTxids) {
    const status = await fetchStatus(txid);
    if (!status || !status.confirmed || typeof status.block_height !== "number") continue;
    if (status.block_height > bestHeight) continue;
    const h = status.block_height;
    const group = byHeight.get(h);
    if (group) group.push(txid);
    else byHeight.set(h, [txid]);
  }
  return [...byHeight.keys()]
    .sort((a, b) => a - b)
    .map((height) => ({ height, txids: byHeight.get(height)! }));
}
```

- [ ] **Step 4: Run → pass**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/esplora-confirm.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/libre-listener-wallet/src/esplora-client.ts packages/libre-listener-wallet/src/tests/unit/esplora-confirm.test.ts
git commit -m "feat(sdk): planBuriedConfirmations — group buried-confirmed watched txs"
```

---

## Task 2: Wire the catch-up pass into `sync()` + verify live

**Files:**
- Modify: `packages/libre-listener-wallet/src/esplora-client.ts` (in `sync()`, between the reorg block and `// 2. Sync forward block-by-block`)

**Interfaces:**
- Consumes: `planBuriedConfirmations` (Task 1); existing `this.fetchTx/fetchBlockHeader/fetchRawTx/fetchMerkleProof`, `this.registeredTxs`, `confirmManager`/`confirmMonitor`, `bestHeight`.

- [ ] **Step 1: Add the catch-up pass**

In `sync()`, immediately after the reorg-check block closes (the `}` ending `if (bestHeight > 0) { ... }`, just before the `// 2. Sync forward block-by-block` comment), insert:
```ts
    // 1.5 Catch-up: confirm watched txs already buried at/below bestHeight.
    // The forward loop (step 2) only confirms txs whose block is in (bestHeight, tip].
    // A funding tx registered AFTER its block was synced — instant regtest mining, or
    // app closed -> funding confirms -> reopen past the block — would otherwise never
    // confirm, leaving the channel stuck "pending" forever (no channel_ready sent).
    {
      const watched = new Set<string>();
      for (const tuple of [...confirmManager.get_relevant_txids(), ...confirmMonitor.get_relevant_txids()]) {
        if (!(tuple.get_c() instanceof Option_ThirtyTwoBytesZ_Some)) {
          watched.add(bytesToHex(tuple.get_a()));
        }
      }
      for (const txidHex of this.registeredTxs.keys()) watched.add(txidHex);

      const groups = await planBuriedConfirmations(
        [...watched],
        async (txid) => {
          try {
            const tx = await this.fetchTx(txid);
            return tx?.status ?? null;
          } catch (e) {
            this.logger?.warn(`Catch-up confirm: failed to fetch tx ${txid}: ${e instanceof Error ? e.message : e}`);
            return null;
          }
        },
        bestHeight,
      );

      for (const { height, txids } of groups) {
        try {
          const header = hexToBytes(await this.fetchBlockHeader(height));
          const entries: { pos: number; rawTx: Uint8Array }[] = [];
          for (const txidHex of txids) {
            const rawTx = hexToBytes(await this.fetchRawTx(txidHex));
            const merkle = await this.fetchMerkleProof(txidHex);
            entries.push({ pos: merkle ? merkle.pos : 0, rawTx });
          }
          entries.sort((a, b) => a.pos - b.pos);
          const txdata = entries.map((e) => TwoTuple_usizeTransactionZ.constructor_new(e.pos, e.rawTx));
          confirmManager.transactions_confirmed(header, txdata, height);
          confirmMonitor.transactions_confirmed(header, txdata, height);
          this.logger?.info(`Catch-up confirmed ${txids.length} buried tx(s) at height ${height}`);
        } catch (e) {
          this.logger?.warn(`Catch-up confirm at height ${height} failed: ${e instanceof Error ? e.message : e}`);
        }
      }
    }

```
(`planBuriedConfirmations`, `Option_ThirtyTwoBytesZ_Some`, `TwoTuple_usizeTransactionZ`, `bytesToHex`, `hexToBytes` are all already in scope in this file.)

- [ ] **Step 2: Typecheck + full SDK suite (no regressions)**

Run: `pnpm --filter @libre/listener-wallet exec tsc --noEmit`
Expected: clean.
Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit`
Expected: PASS (all unit tests, incl. the 4 new ones).

- [ ] **Step 3: Build the SDK (so the app picks it up)**

Run: `pnpm --filter @libre/listener-wallet build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add packages/libre-listener-wallet/src/esplora-client.ts
git commit -m "fix(sdk): confirm buried funding txs in sync() — unstick pending channels"
```

- [ ] **Step 5: Live verification on the real stuck channels**

1. Ensure the docker regtest stack + the app dev server are running and the app is on **regtest**, connected to `libre-lnd`.
2. **Hard-reload** the app (Cmd+Shift+R) so it loads the rebuilt SDK; let the node auto-start + connect.
3. Within ~30s (one sync tick) the catch-up pass runs. Verify lnd now sees the channels active:
   `docker exec libre-lnd lncli --network=regtest listchannels --peer 023ff113fcf583d098a659e2a3c0f7458eb35a873bcd8cedb3648d77d1152074fd | grep -c '"active": true'`
   Expected: ≥ 1 (was 0). The app's channel rows should show **active**.
4. Receive test: create an invoice in the app, pay it from lnd:
   `docker exec libre-lnd lncli --network=regtest payinvoice --force --timeout 55s <invoice>`
   Expected: `Payment status: SUCCEEDED` (was `FAILED, INSUFFICIENT_BALANCE`).
5. Send test: in the app's V4V section set the keysend destination to the lnd pubkey `024228161e3c775fba9255f9253b15cfe12b214113fa7f71b28e42543a14c3ce7d`, send a boost; confirm Spendable drops by the boost amount.

- [ ] **Step 6: Finish** via `superpowers:finishing-a-development-branch` (verify tests, present merge options) — merge only on human approval.

---

## Notes for the implementer
- Insertion point in `sync()`: after the `if (bestHeight > 0) { … }` reorg block, before `// 2. Sync forward block-by-block`. `bestHeight` may have been lowered by the reorg handler — use it as-is.
- Keep the SDK platform-free; no new imports needed beyond what the file already has.
- If live verification step 3 still shows 0 active after a minute, check the app console for `Catch-up confirmed … at height …` logs and for esplora fetch warnings; that localizes whether the pass ran and confirmed.
