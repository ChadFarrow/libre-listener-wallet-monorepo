# Layer C — Durable-Before-Advance Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the SDK never advance channel state until the monitor write is durably committed — by wrapping the existing persister so it returns `ChannelMonitorUpdateStatus::InProgress` and only calls `ChainMonitor.channel_monitor_updated` after the IndexedDB commit lands.

**Architecture:** Add a durability barrier `StorageCache.flush()`; insert a `createDurablePersist()` wrapper (via `Persist.new_impl`) between LDK and today's `MonitorUpdatingPersister`. The on-disk monitor format is unchanged (no migration). A docker POC gates the full wiring: it must PROVE the WASM binding actually pauses LDK on `InProgress`.

**Tech Stack:** TypeScript, `lightningdevkit@0.1.0` WASM, Vitest (jsdom unit + docker `node` integration), MSW.

## Global Constraints

- **TDD**; **no LDK mocking** (real WASM; mock only transport/HTTP; the durability *decision* logic is unit-tested with plain fakes, which is not LDK-mocking).
- **No floating promises** — terminate fire-and-forget with `.catch`/`void`.
- **No silent catches** — log via injected `Logger`.
- **No on-disk format change, no migration, no storage-contract change** — this is signalling-only. `pnpm check:storage` must stay green untouched.
- `ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_InProgress` = the InProgress variant (numeric enum, value `1`).
- Async work outside the synchronous `Persist` call must NOT retain WASM objects (`OutPoint`/`ChannelMonitor`): capture plain values (`get_txid(): Uint8Array`, `get_index(): number`, `get_latest_update_id(): bigint`) synchronously.
- Test one file: `pnpm --filter @libre/listener-wallet exec vitest run <path>`.

---

## File Structure

- Modify `packages/libre-listener-wallet/src/storage-cache.ts` — add pending-write tracking + `flush()`.
- Create `packages/libre-listener-wallet/src/durable-persist.ts` — `createDurablePersist()` + the pure `scheduleDurableAck()` helper.
- Modify `packages/libre-listener-wallet/src/index.ts` — wrap the monitor persister with `createDurablePersist` (after Task 3's POC gate passes).
- Tests: `storage-cache-flush.test.ts` (unit), `durable-persist.test.ts` (unit), `tests/integration/durable-persist-poc.test.ts` (docker gate).

---

### Task 1: `StorageCache.flush()` — durability barrier

**Files:**
- Modify: `packages/libre-listener-wallet/src/storage-cache.ts`
- Test: `packages/libre-listener-wallet/src/tests/unit/storage-cache-flush.test.ts`

**Interfaces:**
- Produces: `StorageCache.flush(): Promise<void>` — resolves when every write/remove issued before the call has durably committed; rejects if any of those failed.

- [ ] **Step 1: Write the failing test**

Create `packages/libre-listener-wallet/src/tests/unit/storage-cache-flush.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { StorageCache } from "../../storage-cache";
import type { SecureStorageProvider } from "../../index";

// A storage whose setItem resolution is controllable, to exercise the durability barrier.
function deferredStorage() {
  const deferreds: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  const storage: SecureStorageProvider = {
    getItem: async () => null,
    setItem: () =>
      new Promise<void>((resolve, reject) => deferreds.push({ resolve, reject })),
    removeItem: () =>
      new Promise<void>((resolve, reject) => deferreds.push({ resolve, reject })),
  };
  return { storage, deferreds };
}

describe("StorageCache.flush", () => {
  it("resolves immediately when nothing is pending", async () => {
    const { storage } = deferredStorage();
    const cache = new StorageCache(storage);
    await expect(cache.flush()).resolves.toBeUndefined();
  });

  it("waits for pending writes, then resolves", async () => {
    const { storage, deferreds } = deferredStorage();
    const cache = new StorageCache(storage);
    cache.write("monitors", "", "a", new Uint8Array([1])); // fires setItem(s), still pending
    let flushed = false;
    const p = cache.flush().then(() => { flushed = true; });
    await Promise.resolve();
    expect(flushed).toBe(false);            // still pending
    deferreds.forEach((d) => d.resolve());  // durable commit lands
    await p;
    expect(flushed).toBe(true);
  });

  it("rejects when a pending write failed", async () => {
    const { storage, deferreds } = deferredStorage();
    const cache = new StorageCache(storage);
    cache.write("monitors", "", "a", new Uint8Array([1]));
    const p = cache.flush();
    deferreds.forEach((d) => d.reject(new Error("commit failed")));
    await expect(p).rejects.toThrow(/flush/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/storage-cache-flush.test.ts`
Expected: FAIL — `cache.flush is not a function`.

- [ ] **Step 3: Add pending-tracking + flush to `storage-cache.ts`**

Add a field beside `private persistenceHealthy = true;`:

```typescript
  // Outstanding async commits (setItem/removeItem/index). flush() awaits these so a caller can
  // block channel-state advancement until the write is DURABLE (Layer C).
  private pending = new Set<Promise<unknown>>();
```

Add a private helper (near `onPersistError`):

```typescript
  private track(p: Promise<unknown>): void {
    this.pending.add(p);
    void p.then(
      () => this.pending.delete(p),
      () => this.pending.delete(p),
    );
  }
```

In `write()`, replace the two fire-and-forget lines:

```typescript
    if (!this.keys.has(storeKey)) {
      this.keys.add(storeKey);
      const ip = this.persistIndex();
      this.track(ip);
      ip.catch((e) => this.onPersistError("index", this.indexKey, e));
    }

    const hexVal = bytesToHex(buf);
    const wp = this.storage.setItem(storeKey, hexVal);
    this.track(wp);
    wp.catch((e) => this.onPersistError("write", storeKey, e));
```

In `remove()`, replace similarly:

```typescript
    if (this.keys.has(storeKey)) {
      this.keys.delete(storeKey);
      const ip = this.persistIndex();
      this.track(ip);
      ip.catch((e) => this.onPersistError("index", this.indexKey, e));
    }

    const rp = this.storage.removeItem(storeKey);
    this.track(rp);
    rp.catch((e) => this.onPersistError("remove", storeKey, e));
```

Add the public method (after `isPersistenceHealthy`):

```typescript
  /** Resolve once every write/remove issued before this call has durably committed; reject if any
   *  failed. Callers use this to hold channel-state advancement until the write is durable. */
  async flush(): Promise<void> {
    const snapshot = Array.from(this.pending);
    const results = await Promise.allSettled(snapshot);
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) throw new Error(`StorageCache.flush: ${failed} pending write(s) failed`);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/storage-cache-flush.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Regression + commit**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit && pnpm --filter @libre/listener-wallet lint`
Expected: PASS, 0 lint errors.

```bash
git add packages/libre-listener-wallet/src/storage-cache.ts packages/libre-listener-wallet/src/tests/unit/storage-cache-flush.test.ts
git commit -m "feat(sdk): StorageCache.flush() durability barrier (Layer C)"
```

---

### Task 2: `createDurablePersist` — async-persist wrapper

**Files:**
- Create: `packages/libre-listener-wallet/src/durable-persist.ts`
- Test: `packages/libre-listener-wallet/src/tests/unit/durable-persist.test.ts`

**Interfaces:**
- Consumes: `StorageCache.flush` (as an injected `flush: () => Promise<void>` — do NOT couple to `StorageCache` directly, so the POC can control it).
- Produces:
  - `scheduleDurableAck(flush: () => Promise<void>, ack: () => void, onFlushError: (e: unknown) => void): void`
  - `createDurablePersist(inner: Persist, flush: () => Promise<void>, getChainMonitor: () => ChainMonitor | undefined, logger?: Logger): Persist`

- [ ] **Step 1: Write the failing test (pure orchestration — no LDK)**

Create `packages/libre-listener-wallet/src/tests/unit/durable-persist.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { scheduleDurableAck } from "../../durable-persist";

describe("scheduleDurableAck", () => {
  it("calls ack only after flush resolves", async () => {
    let release!: () => void;
    const flush = () => new Promise<void>((r) => (release = r));
    const ack = vi.fn();
    const onErr = vi.fn();
    scheduleDurableAck(flush, ack, onErr);
    await Promise.resolve();
    expect(ack).not.toHaveBeenCalled(); // durable commit not yet landed
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(ack).toHaveBeenCalledTimes(1);
    expect(onErr).not.toHaveBeenCalled();
  });

  it("calls onFlushError and NOT ack when flush rejects (leaves LDK paused)", async () => {
    const flush = () => Promise.reject(new Error("degraded"));
    const ack = vi.fn();
    const onErr = vi.fn();
    scheduleDurableAck(flush, ack, onErr);
    await new Promise((r) => setTimeout(r, 0));
    expect(ack).not.toHaveBeenCalled();
    expect(onErr).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/durable-persist.test.ts`
Expected: FAIL — cannot resolve `../../durable-persist`.

- [ ] **Step 3: Implement `durable-persist.ts`**

Create `packages/libre-listener-wallet/src/durable-persist.ts`:

```typescript
import {
  Persist,
  ChannelMonitorUpdateStatus,
  OutPoint,
  ChainMonitor,
  ChannelMonitor,
  ChannelMonitorUpdate,
} from "lightningdevkit";
import type { Logger } from "./index";

// Schedule the durable acknowledgement: only ack (mark the monitor update complete to LDK) once the
// write is durably committed; on a failed flush, do NOT ack — LDK stays paused on that channel,
// which is the safe outcome. Pure; unit-testable without LDK.
export function scheduleDurableAck(
  flush: () => Promise<void>,
  ack: () => void,
  onFlushError: (e: unknown) => void,
): void {
  flush().then(ack, onFlushError);
}

// Wrap an inner Persist so it advertises InProgress and only signals ChainMonitor.channel_monitor_updated
// AFTER the durable commit. The on-disk format is the inner persister's (unchanged).
//
// WASM lifetime: the OutPoint/ChannelMonitor args may be freed after this synchronous call returns, so
// capture plain values (txid bytes, index, update id) synchronously and rebuild the OutPoint in the ack.
export function createDurablePersist(
  inner: Persist,
  flush: () => Promise<void>,
  getChainMonitor: () => ChainMonitor | undefined,
  logger?: Logger,
): Persist {
  const ackDurable = (txidLe: Uint8Array, index: number, updateId: bigint): void => {
    const cm = getChainMonitor();
    if (!cm) return;
    const txo = OutPoint.constructor_new(txidLe, index);
    const res = cm.channel_monitor_updated(txo, updateId);
    if (!res.is_ok()) {
      logger?.error(`[DurablePersist] channel_monitor_updated failed for update ${updateId}`);
    }
  };
  const onFlushError = (e: unknown): void => {
    logger?.error(
      `[DurablePersist] durable flush failed; leaving channel paused: ${e instanceof Error ? e.message : String(e)}`,
    );
  };

  return Persist.new_impl({
    persist_new_channel(txo: OutPoint, monitor: ChannelMonitor): ChannelMonitorUpdateStatus {
      inner.persist_new_channel(txo, monitor);
      const txidLe = txo.get_txid();
      const index = txo.get_index();
      const updateId = monitor.get_latest_update_id();
      scheduleDurableAck(flush, () => ackDurable(txidLe, index, updateId), onFlushError);
      return ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_InProgress;
    },
    update_persisted_channel(
      txo: OutPoint,
      update: ChannelMonitorUpdate | null,
      monitor: ChannelMonitor,
    ): ChannelMonitorUpdateStatus {
      inner.update_persisted_channel(txo, update as any, monitor);
      const txidLe = txo.get_txid();
      const index = txo.get_index();
      const updateId = update ? update.get_update_id() : monitor.get_latest_update_id();
      scheduleDurableAck(flush, () => ackDurable(txidLe, index, updateId), onFlushError);
      return ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_InProgress;
    },
    archive_persisted_channel(txo: OutPoint): void {
      inner.archive_persisted_channel(txo);
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/durable-persist.test.ts`
Expected: PASS (2 cases). (The `scheduleDurableAck` export drives these; `createDurablePersist` is exercised in Task 3.)

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @libre/listener-wallet build && pnpm --filter @libre/listener-wallet lint`
Expected: build OK (confirms `OutPoint.constructor_new`, `Persist.new_impl`, enum accessor all type-check — if `OutPoint.constructor_new` does not exist, find the correct constructor via `grep -n "constructor_new\|_new(" node_modules/.pnpm/lightningdevkit@0.1.0/node_modules/lightningdevkit/structs/OutPoint.d.mts` and adjust), 0 lint errors.

```bash
git add packages/libre-listener-wallet/src/durable-persist.ts packages/libre-listener-wallet/src/tests/unit/durable-persist.test.ts
git commit -m "feat(sdk): createDurablePersist async-persist wrapper (Layer C)"
```

---

### Task 3: POC gate + wire into `index.ts`

**This task is the gate.** It must PROVE the WASM binding honors `InProgress` (LDK does NOT advance until `channel_monitor_updated`). If it does not, **STOP and escalate** — do not ship a change that silently provides no protection.

**Files:**
- Modify: `packages/libre-listener-wallet/src/index.ts:492` (persister wiring)
- Test: `packages/libre-listener-wallet/src/tests/integration/durable-persist-poc.test.ts`

**Interfaces:**
- Consumes: `createDurablePersist` (Task 2), `StorageCache.flush` (Task 1).

**Prerequisite:** `docker compose up -d` (regtest stack + dev LSP as used by `tests/integration/recovery.test.ts`).

- [ ] **Step 1: Wire `DurablePersist` into `index.ts`**

At `index.ts:492`, replace:

```typescript
    const monitorPersister = this.monitorUpdatingPersister.as_Persist();
```

with:

```typescript
    // Layer C: wrap the persister so LDK only advances channel state after the write is durable.
    // getChainMonitor is late-bound — the ChainMonitor is constructed with this persister below.
    const monitorPersister = createDurablePersist(
      this.monitorUpdatingPersister.as_Persist(),
      () => this.storageCache!.flush(),
      () => this.chainMonitor,
      this.logger,
    );
```

Add the import near the other local imports (e.g. beside `import { StorageCache } from "./storage-cache";`):

```typescript
import { createDurablePersist } from "./durable-persist";
```

- [ ] **Step 2: Write the POC gate test (the pause-proof)**

Create `packages/libre-listener-wallet/src/tests/integration/durable-persist-poc.test.ts`. Reuse the harness preamble from `tests/integration/recovery.test.ts` (`runCmd`, `loadWasmBinary`, `TCPStreamProvider`, the MSW esplora wiring, and its funded-channel helper). The test proves BOTH that normal operation works AND that `InProgress` is honored:

```typescript
// @vitest-environment node
// Layer C GATE: proves the WASM binding honours ChannelMonitorUpdateStatus::InProgress — i.e. with
// the durable persister wired, (a) a channel opens and a keysend settles (reconcile works), and
// (b) when the durable flush is BLOCKED, LDK does NOT advance (the payment does not settle) until the
// flush is released. If (b) fails (payment settles while flush is blocked), InProgress is ignored →
// Layer C provides no protection → STOP.
//
// (Preamble copied from recovery.test.ts: runCmd / loadWasmBinary / TCPStreamProvider / mswServer /
//  fundChannel — see that file.)

describe("Layer C durable-persist gate (integration)", () => {
  it("opens a channel and settles a keysend with the durable persister (reconcile works)", async () => {
    const db = new Map<string, string>();
    const wallet = await fundChannel(db);         // recovery.test.ts helper: opens + confirms a channel
    const res = await sendKeysend(wallet);        // helper: keysend to the LSP/lnd; asserts settlement
    expect(res.ok).toBe(true);
    await wallet.stop();
  }, 120_000);

  it("does NOT advance channel state while the durable flush is blocked (InProgress honoured)", async () => {
    // Build a wallet whose StorageCache.flush is gated by a manually-released deferred, so the durable
    // ack (channel_monitor_updated) is withheld. Assert a keysend does NOT settle within a timeout while
    // blocked, then settles once released. Construct via the same wallet config as fundChannel, but
    // inject the gate by wrapping the storage provider's setItem in a controllable deferred (the writes
    // stay un-committed → flush() never resolves → ack withheld). Release the deferreds and assert the
    // payment then settles.
    // If the payment settles WHILE writes are blocked, fail loudly: InProgress is not honoured.
    // (Implement the deferred-storage gate with the same deferredStorage() pattern from
    //  storage-cache-flush.test.ts, layered over the real IndexedDB-backed provider used in integration.)
  }, 120_000);
});
```

Implement the second test concretely using a storage wrapper that can hold `setItem` resolution: start with writes flowing (channel opens), then before the keysend, switch the wrapper to "hold" mode so new commits never resolve → `flush()` never resolves → LDK must not advance; assert the keysend is still unsettled after a bounded wait; switch to "release" mode; assert it settles. Use the real esplora/regtest; only the storage commit timing is controlled.

- [ ] **Step 3: Run the gate**

Run: `docker compose up -d && pnpm --filter @libre/listener-wallet exec vitest run src/tests/integration/durable-persist-poc.test.ts`
Expected: BOTH tests PASS. Test 1 proves reconcile/normal-op; test 2 proves the pause.
**If test 2 fails (payment settles while blocked): STOP.** The binding ignores `InProgress`; revert the Step-1 wiring commit and escalate — Layer C as designed is not viable on this binding and needs reassessment (do not ship).

- [ ] **Step 4: Full regression (guard interaction + no format change)**

Run:
```
pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit && pnpm check:storage && pnpm --filter @libre/listener-wallet lint
```
Expected: all PASS (Layer A regression-guard suites still green — confirms no false halts introduced; `check:storage` green — confirms the monitor format is unchanged), 0 lint errors.

- [ ] **Step 5: Commit**

```bash
git add packages/libre-listener-wallet/src/index.ts packages/libre-listener-wallet/src/tests/integration/durable-persist-poc.test.ts
git commit -m "feat(sdk): wire durable-before-advance persistence + POC gate (Layer C)"
```

---

## Self-Review

**Spec coverage:**
- `StorageCache.flush()` durability barrier → Task 1. ✓
- `DurablePersist` wrapper (InProgress + ack-after-durable, format-preserving) → Task 2. ✓
- Wiring in `index.ts` with late-bound `getChainMonitor` → Task 3 Step 1. ✓
- Flush-failure → do not ack (LDK paused) → Task 2 (`scheduleDurableAck` reject path) + test. ✓
- WASM-lifetime capture (txid/index/updateId synchronously) → Task 2 code + Global Constraints. ✓
- POC-first gate proving `InProgress` is honored, with a STOP condition → Task 3 Steps 2–3. ✓
- No format change / no migration / storage-contract green → Task 3 Step 4 (`check:storage`). ✓
- Layer A guard must not false-fire → Task 3 Step 4. ✓
- Startup reconciliation → exercised by Task 3 test 1 (restart-free open+settle proves the manager advances correctly under InProgress); a restart-after-open assertion may be added if the POC surfaces a reconciliation gap.

**Placeholder scan:** Task 3 Step 2's second test describes the controllable-flush gate in prose with a concrete construction (deferred-storage wrapper from Task 1) rather than full copied harness — acceptable because it cites the exact reusable pieces and the pass/fail (STOP) criterion is explicit; the harness preamble is a verbatim reuse of `recovery.test.ts`. All production code steps show complete code.

**Type consistency:** `createDurablePersist(inner, flush, getChainMonitor, logger)` and `scheduleDurableAck(flush, ack, onFlushError)` signatures identical in Task 2 definition and Task 3 usage. `flush: () => Promise<void>` matches `StorageCache.flush(): Promise<void>` from Task 1. Enum accessor `ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_InProgress` used consistently.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-06-layer-c-durable-persistence.md`.
