# Channel-Gone UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user's (single) channel disappears — force-close, cooperative close, expired LSP lease — the PWA says so, shows fund-recovery status, and guides to a new channel, instead of showing first-run copy and re-triggering onboarding.

**Architecture:** SDK gains persisted `ChannelCloseRecord`s (`Event_ChannelClosed` handler + `close-log.ts`, mirroring `payment-log.ts`) and an observable sweep status (`getSweepStatus()`). The PWA derives ONE `channelLifecycle` state (pure `core/channel-lifecycle.ts`) that the status pill, onboarding gate, channels screen, home hero, and transactions sheet all consume.

**Tech Stack:** TypeScript monorepo, pnpm + turbo, vitest (jsdom for wallet/PWA), LDK WASM bindings (`lightningdevkit@0.1.0`), no LDK mocking.

**Spec:** `docs/superpowers/specs/2026-07-11-channel-gone-ux-design.md`

## Global Constraints

- LDK event dispatch MUST use `event instanceof Event_X` — never `constructor.name` (minification kills it; pinned by `event-dispatch-minify-safe.test.ts`).
- New storage keys are NON-critical (`close_<channelId>`, `sweep_last`): never in the backup, no storage-contract test changes. If `pnpm check:storage` fails, you broke an invariant — stop and rethink; do NOT edit expected values.
- No change to sweep behavior — funds move exactly as before; this adds observability only.
- No LDK internals mocking in tests (`vi.mock('lightningdevkit')` forbidden). Mock storage/HTTP instead.
- PWA rows/copy built with `createElement`/`textContent` — record strings never touch `innerHTML`.
- Demo mode must not require real data; new state fields get safe defaults.
- Errors: no silent catches — log via injected `Logger` and rethrow or return degradation.
- Files kebab-case; run per-package tests with `pnpm --filter <pkg> exec vitest run <path>`.
- Commit after each task (approved by the user via this plan); never push.
- Spec deviation (approved in plan self-review): the close-reason union gains a sixth label `"force-closed"` for LDK's `ClosureReason_CommitmentTxConfirmed` (a commitment tx confirmed on-chain — side unknown, so neither `counterparty-force-closed` nor `we-force-closed` is honest).

---

### Task 1: SDK `close-log.ts` — CloseLogger + record type

**Files:**
- Create: `packages/libre-listener-wallet/src/close-log.ts`
- Test: `packages/libre-listener-wallet/src/tests/unit/close-log.test.ts`

**Interfaces:**
- Consumes: `SecureStorageProvider`, `Logger` from `../index` (type-only, like payment-log.ts).
- Produces (used by Tasks 2, 5): `CLOSE_KEY_PREFIX = "close_"`, `type ChannelCloseReason = "counterparty-force-closed" | "we-force-closed" | "force-closed" | "cooperative" | "outdated-manager" | "other"`, `interface ChannelCloseRecord { channelId: string; counterpartyNodeId?: string; capacitySat?: number; reason: ChannelCloseReason; closedAt: number }`, `class CloseLogger { constructor({storage, logger}); load(); record(rec); getRecords(); isLoaded() }`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/libre-listener-wallet/src/tests/unit/close-log.test.ts
import { describe, it, expect } from "vitest";
import { CloseLogger, CLOSE_KEY_PREFIX, type ChannelCloseRecord } from "../../close-log";
import type { SecureStorageProvider } from "../../index";

function memoryStorage(): SecureStorageProvider & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => void map.set(k, v),
    removeItem: async (k) => void map.delete(k),
    keys: async () => [...map.keys()],
  };
}

const CLOSE: ChannelCloseRecord = {
  channelId: "15bec31c98a700c08436f459c00e0c9b5258972aa21cc4ebddb82eb8c6a963b9",
  counterpartyNodeId: "028ea4e01d6f7e6d80d2d6902eda9304c4bcda78a6abfda3dee2de94ef46a302d5",
  capacitySat: 100_000,
  reason: "counterparty-force-closed",
  closedAt: 1_783_775_545_000,
};

describe("CloseLogger", () => {
  it("persists a close under close_<channelId> and returns it newest-first", async () => {
    const storage = memoryStorage();
    const log = new CloseLogger({ storage });
    log.record(CLOSE);
    log.record({ ...CLOSE, channelId: "aa".repeat(32), closedAt: CLOSE.closedAt + 1000 });
    await new Promise((r) => setTimeout(r, 0)); // fire-and-forget persist settles
    expect(storage.map.has(`${CLOSE_KEY_PREFIX}${CLOSE.channelId}`)).toBe(true);
    const recs = log.getRecords();
    expect(recs).toHaveLength(2);
    expect(recs[0].channelId).toBe("aa".repeat(32)); // newest first
  });

  it("rehydrates from storage via load() and skips unreadable records", async () => {
    const storage = memoryStorage();
    storage.map.set(`${CLOSE_KEY_PREFIX}${CLOSE.channelId}`, JSON.stringify(CLOSE));
    storage.map.set(`${CLOSE_KEY_PREFIX}bad`, "{not json");
    storage.map.set("tx_unrelated", "{}"); // other prefixes ignored
    const log = new CloseLogger({ storage });
    await log.load();
    expect(log.isLoaded()).toBe(true);
    expect(log.getRecords()).toEqual([CLOSE]);
  });

  it("a re-fired close for the same channel upserts (no duplicates)", async () => {
    const storage = memoryStorage();
    const log = new CloseLogger({ storage });
    log.record(CLOSE);
    log.record({ ...CLOSE, reason: "force-closed" }); // LDK can re-emit on restart
    expect(log.getRecords()).toHaveLength(1);
    expect(log.getRecords()[0].reason).toBe("force-closed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/close-log.test.ts`
Expected: FAIL — `Cannot find module '../../close-log'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/libre-listener-wallet/src/close-log.ts
import type { SecureStorageProvider, Logger } from "./index";

// Forward-only, on-device channel-close history. Mirrors payment-log.ts exactly:
// ONE non-critical key per record (`close_<channelId>`), unbounded, never in the
// backup, rehydrated at start() / first read. The LDK `instanceof` event demux stays
// in index.ts (minification-safe); this class is unit-testable without a node.

export const CLOSE_KEY_PREFIX = "close_";
const closeKey = (channelId: string): string => `${CLOSE_KEY_PREFIX}${channelId}`;

export type ChannelCloseReason =
  | "counterparty-force-closed"
  | "we-force-closed"
  | "force-closed" // a commitment tx confirmed on-chain — either side may have closed
  | "cooperative"
  | "outdated-manager"
  | "other";

export interface ChannelCloseRecord {
  channelId: string;
  counterpartyNodeId?: string;
  capacitySat?: number;
  reason: ChannelCloseReason;
  closedAt: number; // ms epoch
}

export interface CloseLoggerDeps {
  storage: SecureStorageProvider;
  logger?: Logger;
}

export class CloseLogger {
  private storage: SecureStorageProvider;
  private logger?: Logger;
  private records: Map<string, ChannelCloseRecord> = new Map();
  private loaded = false;

  constructor(deps: CloseLoggerDeps) {
    this.storage = deps.storage;
    this.logger = deps.logger;
  }

  /** Rehydrate from every persisted `close_*` key. Best-effort. */
  async load(): Promise<void> {
    this.loaded = true;
    if (!this.storage.keys) {
      this.logger?.warn?.("[CloseLog] storage has no keys() — close history disabled for this provider");
      return;
    }
    try {
      const keys = (await this.storage.keys()).filter((k) => k.startsWith(CLOSE_KEY_PREFIX));
      for (const key of keys) {
        try {
          const raw = await this.storage.getItem(key);
          if (!raw) continue;
          const rec = JSON.parse(raw) as ChannelCloseRecord;
          if (rec && typeof rec.channelId === "string") this.records.set(rec.channelId, rec);
        } catch (e) {
          this.logger?.warn?.(`[CloseLog] skipping unreadable record ${key}: ${e instanceof Error ? e.message : e}`);
        }
      }
    } catch (e) {
      this.logger?.error?.(`[CloseLog] load failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Record (or update) a channel close. LDK may re-emit the event on restart — upsert by id. */
  record(rec: ChannelCloseRecord): void {
    this.records.set(rec.channelId, rec);
    // Fire-and-forget: a persist failure must never break event handling.
    void this.storage.setItem(closeKey(rec.channelId), JSON.stringify(rec)).catch((e) => {
      this.logger?.error?.(`[CloseLog] persist ${rec.channelId} failed: ${e instanceof Error ? e.message : e}`);
    });
  }

  /** Newest-first snapshot. */
  getRecords(): ChannelCloseRecord[] {
    return [...this.records.values()].sort((a, b) => b.closedAt - a.closedAt);
  }

  isLoaded(): boolean {
    return this.loaded;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/close-log.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/libre-listener-wallet/src/close-log.ts packages/libre-listener-wallet/src/tests/unit/close-log.test.ts
git commit -m "feat(sdk): CloseLogger — persisted channel-close records (payment-log pattern)"
```

---

### Task 2: SDK — handle `Event_ChannelClosed`, reason mapping, `getChannelCloses()`

**Files:**
- Modify: `packages/libre-listener-wallet/src/index.ts` (LDK import block ~line 79-87; event dispatch ~line 963-972; constructor near `new PaymentLogger`; `start()` near `paymentLog.load`; getters near `getPayments()` ~line 1698; barrel exports ~line 2538)
- Modify: `packages/libre-listener-wallet/src/tests/unit/event-dispatch-minify-safe.test.ts`
- Test: `packages/libre-listener-wallet/src/tests/unit/closure-reason-label.test.ts`

**Interfaces:**
- Consumes: `CloseLogger`, `ChannelCloseRecord`, `ChannelCloseReason` from Task 1.
- Produces (used by Task 5): `wallet.getChannelCloses(): Promise<ChannelCloseRecord[]>`; exported pure `closureReasonLabel(reason: unknown): ChannelCloseReason`; barrel re-export `export { CloseLogger, CLOSE_KEY_PREFIX } from "./close-log"; export type { ChannelCloseRecord, ChannelCloseReason } from "./close-log";`

- [ ] **Step 1: Write the failing tests**

Extend the source guard (`event-dispatch-minify-safe.test.ts`) — add inside the existing `describe`:

```typescript
  it("dispatches channel closes via instanceof (close records depend on it)", () => {
    expect(indexSrc).toMatch(/event\s+instanceof\s+Event_ChannelClosed/);
  });
```

New reason-mapping test (real LDK WASM, no mocking — init boilerplate copied from `bolt11-hints-ldk.test.ts`):

```typescript
// packages/libre-listener-wallet/src/tests/unit/closure-reason-label.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { initializeWasmFromBinary, ClosureReason, Option_boolZ } from "lightningdevkit";
import { closureReasonLabel } from "../../index";

function loadWasmBinary(): Uint8Array {
  const paths = [
    path.resolve(__dirname, "../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(__dirname, "../../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(__dirname, "../../../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "../../node_modules/lightningdevkit/liblightningjs.wasm"),
  ];
  for (const p of paths) if (fs.existsSync(p)) return fs.readFileSync(p);
  throw new Error("Could not find liblightningjs.wasm");
}

beforeAll(async () => {
  await initializeWasmFromBinary(loadWasmBinary());
});

describe("closureReasonLabel", () => {
  it("maps LDK ClosureReason variants to stable labels", () => {
    expect(closureReasonLabel(ClosureReason.constructor_holder_force_closed(Option_boolZ.constructor_none()))).toBe("we-force-closed");
    expect(closureReasonLabel(ClosureReason.constructor_locally_initiated_cooperative_closure())).toBe("cooperative");
    expect(closureReasonLabel(ClosureReason.constructor_counterparty_initiated_cooperative_closure())).toBe("cooperative");
    expect(closureReasonLabel(ClosureReason.constructor_legacy_cooperative_closure())).toBe("cooperative");
    expect(closureReasonLabel(ClosureReason.constructor_commitment_tx_confirmed())).toBe("force-closed");
    expect(closureReasonLabel(ClosureReason.constructor_outdated_channel_manager())).toBe("outdated-manager");
    expect(closureReasonLabel(ClosureReason.constructor_disconnected_peer())).toBe("other");
    expect(closureReasonLabel(undefined)).toBe("other");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/closure-reason-label.test.ts src/tests/unit/event-dispatch-minify-safe.test.ts`
Expected: closure-reason-label FAILS (`closureReasonLabel` not exported); minify-safe's new `it` FAILS (no `instanceof Event_ChannelClosed` in source).

- [ ] **Step 3: Implement in `index.ts`**

3a. Add to the `lightningdevkit` import block (after `Event_SpendableOutputs`):

```typescript
  Event_ChannelClosed,
  ClosureReason,
  ClosureReason_CounterpartyForceClosed,
  ClosureReason_HolderForceClosed,
  ClosureReason_LegacyCooperativeClosure,
  ClosureReason_CounterpartyInitiatedCooperativeClosure,
  ClosureReason_LocallyInitiatedCooperativeClosure,
  ClosureReason_CommitmentTxConfirmed,
  ClosureReason_OutdatedChannelManager,
  Option_u64Z_Some,
```

3b. Add the SDK import + module-scope mapper (near the other `./` imports, e.g. after the `payment-log` import):

```typescript
import { CloseLogger, type ChannelCloseRecord } from "./close-log";
import type { ChannelCloseReason } from "./close-log";

/** Map an LDK ClosureReason to a stable, minification-safe label. Exported for tests. */
export function closureReasonLabel(reason: unknown): ChannelCloseReason {
  if (reason instanceof ClosureReason_CounterpartyForceClosed) return "counterparty-force-closed";
  if (reason instanceof ClosureReason_HolderForceClosed) return "we-force-closed";
  if (reason instanceof ClosureReason_CommitmentTxConfirmed) return "force-closed";
  if (
    reason instanceof ClosureReason_LegacyCooperativeClosure ||
    reason instanceof ClosureReason_CounterpartyInitiatedCooperativeClosure ||
    reason instanceof ClosureReason_LocallyInitiatedCooperativeClosure
  ) {
    return "cooperative";
  }
  if (reason instanceof ClosureReason_OutdatedChannelManager) return "outdated-manager";
  return "other";
}
```

(`ClosureReason` itself is imported for the test's static constructors; keep it even if index.ts only uses the variant classes.)

3c. Class field + constructor init — next to the existing `this.paymentLog = new PaymentLogger(...)` line (search `new PaymentLogger`):

```typescript
  private closeLog: CloseLogger;
```

```typescript
    this.closeLog = new CloseLogger({ storage: this.storage, logger: this.logger });
```

3d. Rehydrate at start — next to the existing `paymentLog.load()` call in `start()` (search `paymentLog.load`):

```typescript
    await this.closeLog.load();
```

3e. Event branch — in `handle_event`, insert between the `Event_PaymentClaimed` and `Event_SpendableOutputs` branches (~line 964):

```typescript
        } else if (event instanceof Event_ChannelClosed) {
          const channelId = bytesToHex(event.channel_id.get_a());
          const counterparty =
            event.counterparty_node_id && event.counterparty_node_id.length === 33 && event.counterparty_node_id.some((b) => b !== 0)
              ? bytesToHex(event.counterparty_node_id)
              : undefined;
          const capacitySat =
            event.channel_capacity_sats instanceof Option_u64Z_Some ? Number(event.channel_capacity_sats.some) : undefined;
          const reason = closureReasonLabel(event.reason);
          this.logger?.info(`[LDK Event] ChannelClosed ${channelId} (${reason})`);
          this.closeLog.record({ channelId, counterpartyNodeId: counterparty, capacitySat, reason, closedAt: Date.now() });
          this.notifyStateChanged();
```

3f. Getter — next to `getPayments()` (~line 1698):

```typescript
  // Channel-close history, newest first. Works with the node stopped (lazily loads).
  async getChannelCloses(): Promise<ChannelCloseRecord[]> {
    if (!this.closeLog.isLoaded()) await this.closeLog.load();
    return this.closeLog.getRecords();
  }
```

3g. Barrel exports — next to the `PaymentLogger` export (~line 2538):

```typescript
export { CloseLogger, CLOSE_KEY_PREFIX } from "./close-log";
export type { ChannelCloseRecord, ChannelCloseReason } from "./close-log";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/closure-reason-label.test.ts src/tests/unit/event-dispatch-minify-safe.test.ts src/tests/unit/close-log.test.ts`
Expected: PASS. Then build + full unit suite: `pnpm --filter @libre/listener-wallet build && pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit`
Expected: PASS (no regressions).

- [ ] **Step 5: Commit**

```bash
git add packages/libre-listener-wallet/src/index.ts packages/libre-listener-wallet/src/tests/unit/closure-reason-label.test.ts packages/libre-listener-wallet/src/tests/unit/event-dispatch-minify-safe.test.ts
git commit -m "feat(sdk): handle Event_ChannelClosed — persisted close records + getChannelCloses()"
```

---

### Task 3: SDK — observable sweep status (`getSweepStatus()`)

**Files:**
- Modify: `packages/libre-listener-wallet/src/index.ts` (fields ~line 392-397; `setSweepDestination` ~1759; `handleSpendableOutputs` ~1771; `broadcastPendingSweeps` ~1845; `loadPendingSweeps` ~1824; barrel exports)
- Test: `packages/libre-listener-wallet/src/tests/unit/sweep-status.test.ts`

**Interfaces:**
- Produces (used by Task 5): `interface SweepStatus { needsAddress: boolean; pendingCount: number; pendingSat: number; lastSweep?: { txid: string; sat: number; at: number } }`, `wallet.getSweepStatus(): SweepStatus`, exported const `SWEEP_LAST_KEY = "sweep_last"` (barrel: `export { SWEEP_LAST_KEY } from ...` — it lives in index.ts, so just `export const`).
- No change to WHEN funds sweep — only observability. `SWEEP_PENDING_KEY` format untouched.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/libre-listener-wallet/src/tests/unit/sweep-status.test.ts
import { describe, it, expect } from "vitest";
import { LibreListenerWallet, type SecureStorageProvider, type WebSocketStreamProvider, type WebSocketConnection } from "../../index";

function memoryStorage(): SecureStorageProvider & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => void map.set(k, v),
    removeItem: async (k) => void map.delete(k),
    keys: async () => [...map.keys()],
  };
}

const mockSocketProvider: WebSocketStreamProvider = {
  connect: async () => ({ send: () => {}, close: () => {} }) as unknown as WebSocketConnection,
};

function makeWallet(storage: SecureStorageProvider) {
  return new LibreListenerWallet({
    config: { network: "regtest", esploraUrl: "http://127.0.0.1:3002" },
    storage,
    socketProvider: mockSocketProvider,
  } as unknown as ConstructorParameters<typeof LibreListenerWallet>[0]);
}

describe("getSweepStatus", () => {
  it("starts clean", () => {
    const w = makeWallet(memoryStorage());
    expect(w.getSweepStatus()).toEqual({ needsAddress: false, pendingCount: 0, pendingSat: 0 });
  });

  it("flags needsAddress when spendable outputs arrive with no destination, clears when one is set", () => {
    const w = makeWallet(memoryStorage());
    // handleSpendableOutputs is private; drive it directly — asserting via the public getter.
    const handled = (w as any).handleSpendableOutputs([{ output: { value: 93_813n } }]);
    expect(handled).toBe(false); // LDK will replay the event — unchanged behavior
    expect(w.getSweepStatus().needsAddress).toBe(true);
    w.setSweepDestination(new Uint8Array([0x00, 0x14, ...new Array(20).fill(1)]));
    expect(w.getSweepStatus().needsAddress).toBe(false);
  });

  it("rehydrates lastSweep from storage at start-time load", async () => {
    const storage = memoryStorage();
    const last = { txid: "ab".repeat(32), sat: 93_813, at: 1_783_775_545_000 };
    storage.map.set("sweep_last", JSON.stringify(last));
    const w = makeWallet(storage);
    await (w as any).loadPendingSweeps();
    expect(w.getSweepStatus().lastSweep).toEqual(last);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/sweep-status.test.ts`
Expected: FAIL — `w.getSweepStatus is not a function`

- [ ] **Step 3: Implement in `index.ts`**

3a. Next to `SWEEP_PENDING_KEY` (~line 299):

```typescript
export const SWEEP_LAST_KEY = "sweep_last"; // non-critical: last completed force-close sweep (display only)
```

3b. New fields next to `sweepWarningShown` (~line 397):

```typescript
  // Observability for the UI (SweepStatus) — display state only, never gates sweeping.
  private sweepNeedsAddress = false;
  private pendingSweepSats: Map<string, number> = new Map(); // txHex → best-effort sat value
  private lastSweep?: { txid: string; sat: number; at: number };
```

3c. New public type + getter (place directly above `setSweepDestination`):

```typescript
export interface SweepStatus {
  needsAddress: boolean;
  pendingCount: number;
  pendingSat: number;
  lastSweep?: { txid: string; sat: number; at: number };
}
```

(NOTE: interfaces can't be declared inside the class — put `SweepStatus` at module scope near `PeerAddress` ~line 286.)

```typescript
  /** UI-facing view of force-close fund recovery. Display only — never gates the sweep itself. */
  getSweepStatus(): SweepStatus {
    let pendingSat = 0;
    for (const v of this.pendingSweepSats.values()) pendingSat += v;
    return {
      needsAddress: this.sweepNeedsAddress,
      pendingCount: this.pendingSweeps.size,
      pendingSat,
      ...(this.lastSweep ? { lastSweep: this.lastSweep } : {}),
    };
  }
```

3d. `setSweepDestination` (~line 1759) — append after the existing two lines:

```typescript
    if (this.sweepDestinationScript && this.sweepNeedsAddress) {
      this.sweepNeedsAddress = false;
      this.notifyStateChanged();
    }
```

3e. `handleSpendableOutputs` no-address branch (~line 1773) — inside `if (!this.sweepDestinationScript) {`, before `return false;`:

```typescript
      if (!this.sweepNeedsAddress) {
        this.sweepNeedsAddress = true;
        this.notifyStateChanged(); // surface "set a recovery address" in the UI
      }
```

3f. When queuing the sweep (~line 1807, after `const key = bytesToHex(txBytes);`):

```typescript
    // Best-effort display value: sum the descriptors' output values (bigint sats).
    let outSat = 0;
    try {
      for (const d of descriptors) {
        const v = (d as any)?.output?.value;
        if (typeof v === "bigint") outSat += Number(v);
        else if (typeof v === "number") outSat += v;
      }
    } catch { /* display-only — never block the sweep */ }
    this.pendingSweepSats.set(key, outSat);
```

3g. `broadcastPendingSweeps` success path (~line 1850, after `this.pendingSweeps.delete(key);`):

```typescript
        const sat = this.pendingSweepSats.get(key) ?? 0;
        this.pendingSweepSats.delete(key);
        try {
          const h1 = await crypto.subtle.digest("SHA-256", txBytes as unknown as ArrayBuffer);
          const txid = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", h1)).reverse());
          this.lastSweep = { txid, sat, at: Date.now() };
          await this.storage.setItem(SWEEP_LAST_KEY, JSON.stringify(this.lastSweep));
        } catch (e) {
          this.logger?.warn(`[Sweep] could not record last-sweep metadata: ${e instanceof Error ? e.message : e}`);
        }
        this.notifyStateChanged();
```

3h. `loadPendingSweeps` (~line 1824) — append at the end of the `try` block (rehydrated pending sweeps have unknown sat → 0):

```typescript
      for (const k of this.pendingSweeps.keys()) if (!this.pendingSweepSats.has(k)) this.pendingSweepSats.set(k, 0);
      const lastRaw = await this.storage.getItem(SWEEP_LAST_KEY);
      if (lastRaw) {
        const parsed = JSON.parse(lastRaw) as { txid?: unknown; sat?: unknown; at?: unknown };
        if (typeof parsed.txid === "string" && typeof parsed.sat === "number" && typeof parsed.at === "number") {
          this.lastSweep = { txid: parsed.txid, sat: parsed.sat, at: parsed.at };
        }
      }
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/sweep-status.test.ts && pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit && pnpm check:storage`
Expected: all PASS (check:storage proves no contract drift).

- [ ] **Step 5: Commit**

```bash
git add packages/libre-listener-wallet/src/index.ts packages/libre-listener-wallet/src/tests/unit/sweep-status.test.ts
git commit -m "feat(sdk): getSweepStatus() — needs-address signal, pending sats, last-sweep record"
```

---

### Task 4: PWA — pure `core/channel-lifecycle.ts`

**Files:**
- Create: `packages/wallet-pwa/src/core/channel-lifecycle.ts`
- Test: `packages/wallet-pwa/src/core/channel-lifecycle.test.ts`

**Interfaces:**
- Produces (used by Tasks 5-9): `type ChannelLifecycle = "none" | "opening" | "active" | "closed-needs-address" | "closed-recovering" | "closed-recovered"`, `channelLifecycle(i: LifecycleInputs): ChannelLifecycle` with `interface LifecycleInputs { channels: number; usableChannels: number; closeCount: number; sweepNeedsAddress: boolean; sweepPendingCount: number }`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/wallet-pwa/src/core/channel-lifecycle.test.ts
import { describe, it, expect } from "vitest";
import { channelLifecycle } from "./channel-lifecycle";

const BASE = { channels: 0, usableChannels: 0, closeCount: 0, sweepNeedsAddress: false, sweepPendingCount: 0 };

describe("channelLifecycle", () => {
  it("none: fresh wallet, nothing ever happened", () => {
    expect(channelLifecycle(BASE)).toBe("none");
  });
  it("active: a usable channel", () => {
    expect(channelLifecycle({ ...BASE, channels: 1, usableChannels: 1 })).toBe("active");
  });
  it("opening: channel exists but not usable (also covers peer-offline — indistinguishable from counts)", () => {
    expect(channelLifecycle({ ...BASE, channels: 1 })).toBe("opening");
  });
  it("closed-needs-address: no channel + claimable funds waiting on a recovery address", () => {
    expect(channelLifecycle({ ...BASE, closeCount: 1, sweepNeedsAddress: true })).toBe("closed-needs-address");
  });
  it("closed-recovering: no channel + a sweep queued/broadcasting", () => {
    expect(channelLifecycle({ ...BASE, closeCount: 1, sweepPendingCount: 1 })).toBe("closed-recovering");
  });
  it("closed-recovered: a close on record, nothing pending", () => {
    expect(channelLifecycle({ ...BASE, closeCount: 1 })).toBe("closed-recovered");
  });
  it("needs-address outranks recovering (both true → the actionable one wins)", () => {
    expect(channelLifecycle({ ...BASE, closeCount: 1, sweepNeedsAddress: true, sweepPendingCount: 1 })).toBe("closed-needs-address");
  });
  it("an open channel outranks stale close records (new channel after a close)", () => {
    expect(channelLifecycle({ ...BASE, channels: 1, usableChannels: 1, closeCount: 3 })).toBe("active");
  });
  it("sweep signals without a close record still surface (event raced the close record)", () => {
    expect(channelLifecycle({ ...BASE, sweepNeedsAddress: true })).toBe("closed-needs-address");
    expect(channelLifecycle({ ...BASE, sweepPendingCount: 1 })).toBe("closed-recovering");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @libre/wallet-pwa exec vitest run src/core/channel-lifecycle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// packages/wallet-pwa/src/core/channel-lifecycle.ts
// The app models ONE channel per user: the wallet is always in exactly one phase of a
// single channel lifecycle. Every channel-related surface (status pill, onboarding gate,
// channels screen, home hero, history) consumes THIS derivation — never re-infers.
// Pure + DOM-free. Only meaningful while the node runs (callers gate on `running` first,
// same as today's pill); close/sweep inputs are storage-backed so they survive restarts.

export type ChannelLifecycle =
  | "none" // never had a channel (or a pre-close-records wallet)
  | "opening" // channel exists, not usable yet (also covers peer-offline — counts can't tell)
  | "active"
  | "closed-needs-address" // funds claimable, no recovery address set — actionable
  | "closed-recovering" // sweep queued/broadcasting
  | "closed-recovered"; // close on record, nothing pending — ready for a new channel

export interface LifecycleInputs {
  channels: number;
  usableChannels: number;
  closeCount: number;
  sweepNeedsAddress: boolean;
  sweepPendingCount: number;
}

export function channelLifecycle(i: LifecycleInputs): ChannelLifecycle {
  if (i.channels > 0) return i.usableChannels > 0 ? "active" : "opening";
  // Sweep signals count even without a close record — the SpendableOutputs event can
  // land before (or without) the close record on older wallets.
  if (i.sweepNeedsAddress) return "closed-needs-address";
  if (i.sweepPendingCount > 0) return "closed-recovering";
  if (i.closeCount > 0) return "closed-recovered";
  return "none";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @libre/wallet-pwa exec vitest run src/core/channel-lifecycle.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/wallet-pwa/src/core/channel-lifecycle.ts packages/wallet-pwa/src/core/channel-lifecycle.test.ts
git commit -m "feat(wallet-pwa): channelLifecycle — the single-channel state derivation"
```

---

### Task 5: Controller — expose closes + sweep in `getState()`

**Files:**
- Modify: `packages/wallet-pwa/src/wallet-controller.ts` (imports line 4; `getState` lines 128-175; near `getPayments` line 619)

**Interfaces:**
- Consumes: `CloseLogger`, `ChannelCloseRecord`, `SweepStatus`, `SWEEP_LAST_KEY` from `@libre/listener-wallet` (Tasks 2-3); `SWEEP_PENDING_KEY` is NOT exported — the stopped-path pending count reads the same `"sweep_pending_txs"` literal via a local const (documented below).
- Produces (used by Tasks 6-9): `getState()` result gains `closes: { count: number; last?: ChannelCloseRecord }` and `sweep: { needsAddress: boolean; pendingCount: number; pendingSat: number; lastSweep?: { txid: string; sat: number; at: number } }` — both ALWAYS present (safe defaults), running or stopped, demo included.

- [ ] **Step 1: Extend the imports and add a stopped-path helper**

In the `@libre/listener-wallet` import at the top (it already imports `PaymentLogger`):

```typescript
import {
  // ...existing names...
  CloseLogger,
  SWEEP_LAST_KEY,
  type ChannelCloseRecord,
} from "@libre/listener-wallet";
```

Below the class's `getPayments` (line 619 area), add:

```typescript
  // Mirror of the SDK's SWEEP_PENDING_KEY ("sweep_pending_txs") for the stopped-node read.
  // Display-only: a drifted literal shows 0 pending, it can never affect the sweep itself.
  private static readonly SWEEP_PENDING_STORAGE_KEY = "sweep_pending_txs";

  // Channel-close history (SDK CloseLogger is the source of truth). Works with the node
  // STOPPED — fresh CloseLogger over storage, same pattern as getPayments().
  async getChannelCloses(): Promise<ChannelCloseRecord[]> {
    if (this.isRunning()) return this.wallet!.getChannelCloses();
    const log = new CloseLogger({ storage: this.storageForNetwork(await this.activeNetwork()) });
    await log.load();
    return log.getRecords();
  }
```

- [ ] **Step 2: Extend `getState()`**

Add to the return-type literal (after `startError?: string;`):

```typescript
    closes: { count: number; last?: ChannelCloseRecord };
    sweep: { needsAddress: boolean; pendingCount: number; pendingSat: number; lastSweep?: { txid: string; sat: number; at: number } };
```

In the body, before the `return`, add:

```typescript
    const closeRecs = await this.getChannelCloses().catch(() => [] as ChannelCloseRecord[]);
    const closes = { count: closeRecs.length, ...(closeRecs[0] ? { last: closeRecs[0] } : {}) };
    let sweep: { needsAddress: boolean; pendingCount: number; pendingSat: number; lastSweep?: { txid: string; sat: number; at: number } } = {
      needsAddress: false,
      pendingCount: 0,
      pendingSat: 0,
    };
    if (running && this.wallet) {
      sweep = this.wallet.getSweepStatus();
    } else {
      // Stopped: best-effort from storage so the pill can still say "recovering".
      try {
        const pendingRaw = await storage.getItem(WalletController.SWEEP_PENDING_STORAGE_KEY);
        const pending = pendingRaw ? (JSON.parse(pendingRaw) as unknown[]) : [];
        const lastRaw = await storage.getItem(SWEEP_LAST_KEY);
        const last = lastRaw ? (JSON.parse(lastRaw) as { txid: string; sat: number; at: number }) : undefined;
        sweep = {
          needsAddress: false, // only knowable while running
          pendingCount: Array.isArray(pending) ? pending.length : 0,
          pendingSat: 0,
          ...(last ? { lastSweep: last } : {}),
        };
      } catch { /* defaults stand — display-only */ }
    }
```

And add `closes, sweep,` to the returned object.

(If the class name isn't `WalletController`, use the actual class name for the static — check the `export class` line.)

- [ ] **Step 3: Typecheck + existing tests still green**

Run: `pnpm --filter @libre/wallet-pwa exec tsc --noEmit -p tsconfig.json 2>/dev/null || pnpm --filter @libre/wallet-pwa build`
Then: `pnpm --filter @libre/wallet-pwa test`
Expected: PASS. (Tests that stub `getState` with object literals keep passing — the new fields are consumed with `?? `/defaults everywhere per Tasks 6-8.)

- [ ] **Step 4: Commit**

```bash
git add packages/wallet-pwa/src/wallet-controller.ts
git commit -m "feat(wallet-pwa): getState exposes channel closes + sweep status (works stopped)"
```

---

### Task 6: Status pill on lifecycle + home wiring + recovering sub-line

**Files:**
- Modify: `packages/wallet-pwa/src/core/status-pill.ts`
- Modify: `packages/wallet-pwa/src/core/status-pill.test.ts` (intentional behavior change — NOT a storage contract)
- Modify: `packages/wallet-pwa/src/screens/home.ts` (PILL_SCREEN line 13; pill inputs line 49; hero sub-line in `refresh`)
- Modify: `packages/wallet-pwa/index.html` (line 40 area — one new hero element)

**Interfaces:**
- Consumes: `ChannelLifecycle`, `channelLifecycle` (Task 4); `getState().closes/.sweep` (Task 5).
- Produces: `StatusPillInputs` becomes `{ hasWallet, running, startError?, lifecycle: ChannelLifecycle, driveConfigured, backedUp }`; `StatusPillTarget` gains `"sweep"`; `PILL_SCREEN` maps `sweep → "screen-sweep"`.

- [ ] **Step 1: Rewrite the failing tests**

Replace `packages/wallet-pwa/src/core/status-pill.test.ts` with:

```typescript
import { describe, it, expect } from "vitest";
import { statusPill } from "./status-pill";
import type { ChannelLifecycle } from "./channel-lifecycle";

const HEALTHY = {
  hasWallet: true,
  running: true,
  lifecycle: "active" as ChannelLifecycle,
  driveConfigured: true,
  backedUp: true,
};

describe("statusPill", () => {
  it("is hidden when everything is healthy", () => {
    expect(statusPill(HEALTHY)).toBeNull();
  });

  it("is hidden with no wallet (onboarding owns that state)", () => {
    expect(statusPill({ ...HEALTHY, hasWallet: false, running: false, lifecycle: "none" })).toBeNull();
  });

  it("node stopped outranks everything and targets the node screen", () => {
    const p = statusPill({ ...HEALTHY, running: false, lifecycle: "none", driveConfigured: false, backedUp: false });
    expect(p).toMatchObject({ level: "bad", target: "node" });
    expect(p!.text).toMatch(/node/i);
  });

  it("includes the start error reason when present", () => {
    const p = statusPill({ ...HEALTHY, running: false, startError: "Esplora unreachable" });
    expect(p!.text).toContain("Esplora unreachable");
  });

  it("closed-needs-address → bad, targets the sweep screen (fund-safety prompt)", () => {
    const p = statusPill({ ...HEALTHY, lifecycle: "closed-needs-address" });
    expect(p).toMatchObject({ level: "bad", target: "sweep" });
    expect(p!.text).toMatch(/recovery address/i);
  });

  it("closed-recovering → info, targets the sweep screen", () => {
    const p = statusPill({ ...HEALTHY, lifecycle: "closed-recovering" });
    expect(p).toMatchObject({ level: "info", target: "sweep" });
    expect(p!.text).toMatch(/recovering/i);
  });

  it("closed-recovered → warn 'get a new one', NOT first-run copy", () => {
    const p = statusPill({ ...HEALTHY, lifecycle: "closed-recovered" });
    expect(p).toMatchObject({ level: "warn", target: "get-channel" });
    expect(p!.text).toMatch(/closed/i);
    expect(p!.text).not.toMatch(/no channel yet/i);
  });

  it("none (never had) keeps the first-run copy", () => {
    const p = statusPill({ ...HEALTHY, lifecycle: "none" });
    expect(p).toMatchObject({ level: "warn", target: "get-channel" });
    expect(p!.text).toMatch(/no channel yet/i);
  });

  it("opening → info targeting channels (unchanged copy)", () => {
    const p = statusPill({ ...HEALTHY, lifecycle: "opening" });
    expect(p).toMatchObject({ level: "info", target: "channels" });
    expect(p!.text).toMatch(/opening/i);
  });

  it("seed not backed up → warn targeting recovery", () => {
    expect(statusPill({ ...HEALTHY, backedUp: false })).toMatchObject({ level: "warn", target: "recovery" });
  });

  it("Drive not configured → warn targeting cloud-backup", () => {
    expect(statusPill({ ...HEALTHY, driveConfigured: false })).toMatchObject({ level: "warn", target: "cloud-backup" });
  });

  it("priority: closed states outrank backup drift", () => {
    const p = statusPill({ ...HEALTHY, lifecycle: "closed-needs-address", backedUp: false, driveConfigured: false });
    expect(p!.target).toBe("sweep");
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `pnpm --filter @libre/wallet-pwa exec vitest run src/core/status-pill.test.ts`
Expected: FAIL (type errors / old rung behavior).

- [ ] **Step 3: Rewrite `status-pill.ts`**

```typescript
// Home-screen status pill: surfaces POST-onboarding regressions only (onboarding itself is a
// hard gate — no wallet / incomplete setup never reaches home). Pure and priority-ordered so
// the single most actionable problem shows; tapping deep-links to `target`. Channel state
// comes in as the ONE channelLifecycle derivation (core/channel-lifecycle.ts) — never raw counts.
import type { ChannelLifecycle } from "./channel-lifecycle";

export interface StatusPillInputs {
  hasWallet: boolean;
  running: boolean;
  startError?: string;
  lifecycle: ChannelLifecycle;
  driveConfigured: boolean;
  backedUp: boolean;
}

export type StatusPillTarget = "node" | "get-channel" | "channels" | "cloud-backup" | "recovery" | "sweep";

export interface StatusPill {
  level: "bad" | "warn" | "info";
  text: string;
  target: StatusPillTarget;
}

export function statusPill(i: StatusPillInputs): StatusPill | null {
  if (!i.hasWallet) return null; // onboarding owns the no-wallet state

  if (!i.running) {
    return {
      level: "bad",
      text: i.startError ? `Node stopped — ${i.startError}` : "Node stopped — tap to start",
      target: "node",
    };
  }
  switch (i.lifecycle) {
    case "closed-needs-address":
      return { level: "bad", text: "Channel closed — set a recovery address to get your funds", target: "sweep" };
    case "closed-recovering":
      return { level: "info", text: "Channel closed — recovering your funds on-chain", target: "sweep" };
    case "closed-recovered":
      return { level: "warn", text: "Channel closed — get a new one", target: "get-channel" };
    case "none":
      return { level: "warn", text: "No channel yet — get one to receive", target: "get-channel" };
    case "opening":
      return { level: "info", text: "Channel opening — this can take a bit", target: "channels" };
    case "active":
      break;
  }
  if (!i.backedUp) {
    return { level: "warn", text: "Back up your wallet seed", target: "recovery" };
  }
  if (!i.driveConfigured) {
    return { level: "warn", text: "Turn on cloud backup", target: "cloud-backup" };
  }
  return null;
}
```

- [ ] **Step 4: Wire home.ts**

4a. `PILL_SCREEN` (line 13) gains:

```typescript
  sweep: "screen-sweep",
```

4b. In `refresh()` replace the `statusPill({...})` call (lines 49-57) with:

```typescript
      const lifecycle = channelLifecycle({
        channels: s.channels ?? 0,
        usableChannels: s.usableChannels ?? 0,
        closeCount: s.closes?.count ?? 0,
        sweepNeedsAddress: s.sweep?.needsAddress ?? false,
        sweepPendingCount: s.sweep?.pendingCount ?? 0,
      });
      const pill = statusPill({
        hasWallet: s.hasSeed || s.createdNew || s.hasChannelState,
        running: s.running,
        startError: s.startError,
        lifecycle,
        driveConfigured: isDemoMode() ? demoState.driveConfigured : driveConfigured(),
        backedUp: isDemoMode() ? demoState.seedBackedUp : getSeedBackedUp(s.network),
      });
```

with the import added at the top:

```typescript
import { channelLifecycle } from "../core/channel-lifecycle";
```

4c. Hero sub-line. In `index.html`, after line 40 (`<div class="fiat hidden" id="balance-fiat"></div>`), add:

```html
          <div class="fiat hidden" id="balance-recovering"></div>
```

In `refresh()` after the fiat-line block (line 47), add:

```typescript
      // Post-close context: balance 0 is not "empty wallet" while funds are coming back on-chain.
      const recEl = $("balance-recovering");
      if (lifecycle === "closed-recovering" || lifecycle === "closed-needs-address") {
        const sat = s.sweep?.pendingSat ?? 0;
        recEl.textContent =
          lifecycle === "closed-needs-address"
            ? "Channel closed — funds waiting for a recovery address"
            : sat > 0
              ? `Recovering ${fmtSats(sat)} sats to your on-chain address`
              : "Recovering your funds on-chain";
        show(recEl, true);
      } else {
        show(recEl, false);
      }
```

(Note: `lifecycle` must be computed BEFORE this block — order in `refresh()`: balance → lifecycle → recovering sub-line → pill.)

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @libre/wallet-pwa test`
Expected: PASS — including the untouched DOM tests (`drawer-nav`, `start-regression`, `node-lock`), whose stubbed `getState` lacks `closes`/`sweep`: home.ts consumes them with `?? ` defaults, so nothing throws.

- [ ] **Step 6: Commit**

```bash
git add packages/wallet-pwa/src/core/status-pill.ts packages/wallet-pwa/src/core/status-pill.test.ts packages/wallet-pwa/src/screens/home.ts packages/wallet-pwa/index.html
git commit -m "feat(wallet-pwa): lifecycle-driven status pill — closed≠never, recovery prompt + hero sub-line"
```

---

### Task 7: Onboarding — `everHadChannel` + done guard

**Files:**
- Modify: `packages/wallet-pwa/src/core/onboarding-flow.ts`
- Modify: `packages/wallet-pwa/src/core/onboarding-flow.test.ts`
- Modify: `packages/wallet-pwa/src/screens/onboarding.ts` (evaluate line 38-45; onControllerEvent line 258)

**Interfaces:**
- Produces: `OnboardingInputs` gains `everHadChannel: boolean`; channel step fires only when `channels === 0 && !everHadChannel`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/wallet-pwa/src/core/onboarding-flow.test.ts` (match the file's existing style; add `everHadChannel: false` to every existing input literal to satisfy the type):

```typescript
  it("a wallet that HAD a channel (close on record) never re-enters the channel step", () => {
    expect(
      currentOnboardingStep({ hasWallet: true, backedUp: true, driveConfigured: true, channels: 0, everHadChannel: true })
    ).toBe("done");
  });

  it("a brand-new wallet with no channel still gets the channel step", () => {
    expect(
      currentOnboardingStep({ hasWallet: true, backedUp: true, driveConfigured: true, channels: 0, everHadChannel: false })
    ).toBe("channel");
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @libre/wallet-pwa exec vitest run src/core/onboarding-flow.test.ts`
Expected: FAIL (unknown property / step === "channel" for the first case).

- [ ] **Step 3: Implement**

`onboarding-flow.ts`:

```typescript
export interface OnboardingInputs {
  hasWallet: boolean;
  backedUp: boolean; // per-network seed-backed-up marker (core/onboarding.ts)
  driveConfigured: boolean; // remembered Drive account — the mandatory-backup gate signal
  channels: number; // total channels incl. pending — the pill handles "opening"
  everHadChannel: boolean; // close record or prior channel state — a RETURNING user, not a first-run
}

export function currentOnboardingStep(i: OnboardingInputs): OnboardingStep {
  if (!i.hasWallet) return "welcome";
  if (!i.backedUp) return "seed";
  if (!i.driveConfigured) return "drive";
  // Only a wallet that never had a channel gets the first-channel step. After a close the
  // status pill owns the "get a new one" nudge — the full-screen gate must not hijack home.
  if (i.channels === 0 && !i.everHadChannel) return "channel";
  return "done";
}
```

`screens/onboarding.ts` — in `evaluate()` (line 38-45), add to the `currentOnboardingStep({...})` inputs:

```typescript
        everHadChannel: (s.closes?.count ?? 0) > 0 || s.hasChannelState,
```

And line 258, the re-summon fix:

```typescript
  onControllerEvent(() => {
    if (!done) void evaluate();
  });
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @libre/wallet-pwa test`
Expected: PASS (including existing onboarding-flow cases updated with `everHadChannel: false`).

- [ ] **Step 5: Commit**

```bash
git add packages/wallet-pwa/src/core/onboarding-flow.ts packages/wallet-pwa/src/core/onboarding-flow.test.ts packages/wallet-pwa/src/screens/onboarding.ts
git commit -m "fix(wallet-pwa): onboarding never re-triggers after a channel close (everHadChannel + done guard)"
```

---

### Task 8: Channels screen close-aware empty state + get-channel framing + DOM test

**Files:**
- Modify: `packages/wallet-pwa/src/screens/channels.ts` (refresh lines 76-93)
- Modify: `packages/wallet-pwa/src/screens/get-channel.ts` (onShow line 111-112)
- Modify: `packages/wallet-pwa/index.html` (screen-get-channel title line ~149)
- Test: `packages/wallet-pwa/src/screens/channel-gone.test.ts`

**Interfaces:**
- Consumes: `getState().closes/.sweep` (Task 5), `relativeTime` from `../core/tx-format`, `channelLifecycle` (Task 4).

- [ ] **Step 1: Write the failing DOM test** (harness copied from `drawer-nav.test.ts`)

```typescript
// packages/wallet-pwa/src/screens/channel-gone.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initScreens } from "./index";
import { showScreen } from "../ui/nav";
import type { AppContext } from "../core/app-context";
import type { WalletController } from "../wallet-controller";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadMarkup(): void {
  const html = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf-8");
  document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "";
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const CLOSED_STATE = {
  network: "mainnet",
  running: true,
  hasSeed: true,
  hasChannelState: true,
  createdNew: false,
  channels: 0,
  usableChannels: 0,
  peers: 1,
  closes: { count: 1, last: { channelId: "ab".repeat(32), reason: "counterparty-force-closed", closedAt: Date.now() - 3_600_000 } },
  sweep: { needsAddress: false, pendingCount: 1, pendingSat: 93_813 },
};

function makeCtx(state: unknown): AppContext {
  const controller = {
    getState: vi.fn().mockResolvedValue(state),
    getPayments: vi.fn().mockResolvedValue([]),
    getChannelCloses: vi.fn().mockResolvedValue([]),
    listPeers: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue({ spendableSat: 0, receivableSat: 0 }),
    getChannels: vi.fn().mockResolvedValue([]),
  } as unknown as WalletController;
  return { controller, isRunning: () => true, keepAlive: { start() {}, stop() {}, isActive: () => false } };
}

describe("channel-gone UX", () => {
  beforeEach(() => {
    loadMarkup();
    localStorage.clear();
  });

  it("channels screen shows the close-aware empty state, not first-run copy", async () => {
    initScreens(makeCtx(CLOSED_STATE));
    await flush();
    showScreen("screen-channels");
    await flush();
    const list = document.getElementById("channels-list")!;
    expect(list.textContent).toMatch(/channel closed/i);
    expect(list.textContent).toMatch(/recovering/i);
    expect(list.textContent).not.toMatch(/no channels yet/i);
  });

  it("channels screen keeps first-run copy for a wallet that never had one", async () => {
    initScreens(makeCtx({ ...CLOSED_STATE, hasChannelState: false, closes: { count: 0 }, sweep: { needsAddress: false, pendingCount: 0, pendingSat: 0 } }));
    await flush();
    showScreen("screen-channels");
    await flush();
    expect(document.getElementById("channels-list")!.textContent).toMatch(/no channels yet/i);
  });

  it("get-channel screen reads 'Get a new channel' after a close", async () => {
    initScreens(makeCtx(CLOSED_STATE));
    await flush();
    showScreen("screen-get-channel");
    await flush();
    expect(document.getElementById("gc-title")!.textContent).toBe("Get a new channel");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @libre/wallet-pwa exec vitest run src/screens/channel-gone.test.ts`
Expected: FAIL — first-run copy shown; `gc-title` element missing.

- [ ] **Step 3: Implement**

3a. `index.html` line ~149: give the get-channel title an id:

```html
          <div class="title" id="gc-title">Get a channel</div>
```

3b. `screens/get-channel.ts` — replace the `registerScreen` block (lines 111-112):

```typescript
  registerScreen("screen-get-channel", {
    onShow: () => {
      void (async () => {
        // Honest framing for a returning user: after a close this is a REPLACEMENT channel.
        try {
          const s = await controller.getState();
          $("gc-title").textContent = (s.closes?.count ?? 0) > 0 ? "Get a new channel" : "Get a channel";
        } catch { /* keep the static title */ }
        await placeOrder();
      })();
    },
```

(keep any other properties the existing `registerScreen` options object has — only `onShow` changes.)

3c. `screens/channels.ts` — replace the empty-state branch in `refresh()` (lines 86-91):

```typescript
    const chans = await controller.getChannels().catch(() => [] as ChannelInfo[]);
    if (!chans.length) {
      const s = await controller.getState().catch(() => null);
      const closes = s?.closes?.count ?? 0;
      const sweep = s?.sweep;
      if (closes > 0 || sweep?.needsAddress || (sweep?.pendingCount ?? 0) > 0) {
        const when = s?.closes?.last ? ` ${relativeTime(s.closes.last.closedAt, Date.now())}` : "";
        note.textContent = `Your channel closed${when}.`;
        host.appendChild(note);
        const sweepNote = document.createElement("p");
        sweepNote.className = "center-note";
        if (sweep?.needsAddress) {
          sweepNote.textContent = "Funds are waiting — set a recovery address to get them back on-chain.";
        } else if ((sweep?.pendingCount ?? 0) > 0) {
          sweepNote.textContent =
            (sweep?.pendingSat ?? 0) > 0
              ? `Recovering ${fmtSats(sweep!.pendingSat)} sats to your on-chain address…`
              : "Recovering your funds on-chain…";
        } else if (sweep?.lastSweep) {
          sweepNote.textContent = `${fmtSats(sweep.lastSweep.sat)} sats were sent to your recovery address.`;
        } else {
          sweepNote.textContent = "Get a new channel to keep sending and receiving.";
        }
        host.appendChild(sweepNote);
        return;
      }
      note.textContent = "No channels yet — get one to receive.";
      host.appendChild(note);
      return;
    }
```

with the import added at the top of channels.ts:

```typescript
import { relativeTime } from "../core/tx-format";
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @libre/wallet-pwa test`
Expected: PASS (new DOM test + all existing).

- [ ] **Step 5: Commit**

```bash
git add packages/wallet-pwa/src/screens/channels.ts packages/wallet-pwa/src/screens/get-channel.ts packages/wallet-pwa/index.html packages/wallet-pwa/src/screens/channel-gone.test.ts
git commit -m "feat(wallet-pwa): close-aware channels empty state + 'Get a new channel' framing"
```

---

### Task 9: Transaction history — close + sweep rows

**Files:**
- Modify: `packages/wallet-pwa/src/core/tx-format.ts`
- Modify: `packages/wallet-pwa/src/core/tx-format.test.ts` (append cases)
- Modify: `packages/wallet-pwa/src/screens/transactions-sheet.ts`

**Interfaces:**
- Consumes: `ChannelCloseRecord` (via `@libre/listener-wallet`), `controller.getChannelCloses()` + `getState().sweep.lastSweep` (Task 5).
- Produces: `interface ChannelEventRecord { kind: "channel-close" | "sweep"; timestamp: number; sat?: number; reason?: string }`, `channelEventLabel(rec): string`, `groupByDay<T extends { timestamp: number }>(records, now)` (generic; `groupPaymentsByDay` stays as a thin alias — DRY, no caller churn).

- [ ] **Step 1: Write the failing tests** (append to `tx-format.test.ts`)

```typescript
import { groupByDay, channelEventLabel, type ChannelEventRecord } from "./tx-format";

describe("channel event rows", () => {
  it("labels closes and sweeps", () => {
    expect(channelEventLabel({ kind: "channel-close", timestamp: 0 })).toBe("Channel closed");
    expect(channelEventLabel({ kind: "sweep", timestamp: 0, sat: 93813 })).toBe("Funds recovered on-chain");
  });

  it("groupByDay is generic over anything with a timestamp", () => {
    const now = Date.UTC(2026, 6, 11, 12);
    const items: ChannelEventRecord[] = [
      { kind: "sweep", timestamp: now - 1000, sat: 1 },
      { kind: "channel-close", timestamp: now - 90_000_000 }, // yesterday-ish
    ];
    const groups = groupByDay(items, now);
    expect(groups[0].label).toBe("Today");
    expect(groups[0].records[0].kind).toBe("sweep");
    expect(groups.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @libre/wallet-pwa exec vitest run src/core/tx-format.test.ts`
Expected: FAIL — `groupByDay`/`channelEventLabel` not exported.

- [ ] **Step 3: Implement in `tx-format.ts`**

Replace `groupPaymentsByDay` (lines 47-72) with the generic + alias, and add the channel-event helpers:

```typescript
export interface DayGroup<T> {
  label: string; // "Today" | "Yesterday" | "YYYY-MM-DD"
  records: T[];
}
export type PaymentDayGroup = DayGroup<PaymentRecord>;

const DAY_MS = 86_400_000;

// Group an already-sorted (newest-first) list under day separators. UTC day boundaries
// keep the labels deterministic across machines/timezones. Generic: payments and channel
// events share the sheet, so they share the grouping.
export function groupByDay<T extends { timestamp: number }>(records: T[], now: number): DayGroup<T>[] {
  const todayDay = Math.floor(now / DAY_MS);
  const groups: DayGroup<T>[] = [];
  for (const rec of records) {
    const day = Math.floor(rec.timestamp / DAY_MS);
    const label =
      day === todayDay ? "Today" : day === todayDay - 1 ? "Yesterday" : new Date(day * DAY_MS).toISOString().slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.records.push(rec);
    else groups.push({ label, records: [rec] });
  }
  return groups;
}

export const groupPaymentsByDay = groupByDay<PaymentRecord>;

// A channel lifecycle event rendered in the same sheet as payments.
export interface ChannelEventRecord {
  kind: "channel-close" | "sweep";
  timestamp: number;
  sat?: number; // sweep: recovered amount (0/undefined when unknown)
  reason?: string; // close: stable ChannelCloseReason label
}

export function channelEventLabel(rec: ChannelEventRecord): string {
  return rec.kind === "channel-close" ? "Channel closed" : "Funds recovered on-chain";
}
```

- [ ] **Step 4: Render in `transactions-sheet.ts`**

4a. Imports (line 4):

```typescript
import { formatAmount, relativeTime, groupByDay, channelEventLabel, type ChannelEventRecord } from "../core/tx-format";
```

4b. Add a row builder after `txRow` (line 77) and a neutral icon next to the others (line 19):

```typescript
const LINK_OFF =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 12h6M7.5 8.5L5 11a4 4 0 105.7 5.7l1.3-1.4M16.5 15.5L19 13a4 4 0 10-5.7-5.7l-1.3 1.4"/></svg>';
```

```typescript
function channelEventRow(rec: ChannelEventRecord, now: number): HTMLElement {
  const row = document.createElement("div");
  row.className = `tx ${rec.kind === "sweep" ? "received" : "chan-event"}`;

  const ico = document.createElement("div");
  ico.className = "tx-ico";
  ico.innerHTML = rec.kind === "sweep" ? ARROW_DOWN : LINK_OFF;

  const mid = document.createElement("div");
  mid.className = "tx-mid";
  const l1 = document.createElement("div");
  l1.className = "tx-l1";
  const label = document.createElement("span");
  label.textContent = channelEventLabel(rec);
  const when = document.createElement("span");
  when.className = "when";
  when.textContent = relativeTime(rec.timestamp, now);
  l1.append(label, when);
  mid.appendChild(l1);
  if (rec.kind === "channel-close" && rec.reason) {
    const l2 = document.createElement("div");
    l2.className = "tx-l2";
    l2.textContent = rec.reason.replace(/-/g, " ");
    mid.appendChild(l2);
  }

  const amt = document.createElement("div");
  amt.className = "tx-amt";
  if (rec.kind === "sweep" && rec.sat) {
    const sats = document.createElement("div");
    sats.className = "sats";
    sats.textContent = `+${Math.abs(Math.round(rec.sat)).toLocaleString("en-US")} sats`;
    amt.appendChild(sats);
  }

  row.append(ico, mid, amt);
  return row;
}
```

4c. In `refresh()` (lines 82-108), merge the streams — replace the body after the `records` fetch with:

```typescript
    let events: ChannelEventRecord[] = [];
    try {
      const closes = await controller.getChannelCloses();
      events = closes.map((c) => ({ kind: "channel-close" as const, timestamp: c.closedAt, reason: c.reason }));
      const s = await controller.getState();
      if (s.sweep?.lastSweep) {
        events.push({ kind: "sweep", timestamp: s.sweep.lastSweep.at, sat: s.sweep.lastSweep.sat });
      }
    } catch (e) {
      console.warn("[Tx] channel events unavailable:", (e as Error)?.message || e);
    }
    host.innerHTML = "";
    if (!records.length && !events.length) {
      const note = document.createElement("p");
      note.className = "center-note";
      note.id = "tx-empty";
      note.textContent = "No transactions yet.";
      host.appendChild(note);
      return;
    }
    const now = Date.now();
    const usdRate = await getUsdRate();
    type SheetItem = { timestamp: number; payment?: PaymentRecord; event?: ChannelEventRecord };
    const items: SheetItem[] = [
      ...records.map((p) => ({ timestamp: p.timestamp, payment: p })),
      ...events.map((ev) => ({ timestamp: ev.timestamp, event: ev })),
    ].sort((a, b) => b.timestamp - a.timestamp);
    for (const group of groupByDay(items, now)) {
      const sep = document.createElement("div");
      sep.className = "day-sep";
      sep.textContent = group.label;
      host.appendChild(sep);
      for (const item of group.records) {
        host.appendChild(item.payment ? txRow(item.payment, now, usdRate) : channelEventRow(item.event!, now));
      }
    }
```

(Controller must expose `getChannelCloses()` — added in Task 5.)

- [ ] **Step 5: Run tests + full verification**

```bash
pnpm --filter @libre/wallet-pwa test
pnpm check:storage
pnpm build
pnpm lint
pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit
```
Expected: ALL PASS. `check:storage` green proves no on-disk invariant moved.

- [ ] **Step 6: Commit**

```bash
git add packages/wallet-pwa/src/core/tx-format.ts packages/wallet-pwa/src/core/tx-format.test.ts packages/wallet-pwa/src/screens/transactions-sheet.ts
git commit -m "feat(wallet-pwa): channel closes + sweeps appear in transaction history"
```

---

### Task 10: End-to-end verification pass

**Files:** none (verification only)

- [ ] **Step 1: Full monorepo gates**

```bash
pnpm build && pnpm lint && pnpm check:storage
pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit
pnpm --filter @libre/wallet-pwa test
```
Expected: all green, 0 lint errors.

- [ ] **Step 2: Drive the real flow (dev server)**

Run `pnpm --filter @libre/wallet-pwa dev`, open `http://127.0.0.1:5173?demo` — verify home/pill/channels/sheet render unchanged in demo (safe defaults, no crash). Then the real regtest close: `docker compose up -d`, open a channel from `libre-lnd` to a dev wallet (`--private --channel_type anchors`), force-close from lnd (`lncli --network=regtest closechannel --force <chan_point>`), mine blocks, and observe in the app: pill flips to "Channel closed — …", channels screen shows the close-aware state, onboarding does NOT re-appear, and the close row shows in the sheet. (This mirrors the 2026-07-11 mainnet incident end-to-end.)

- [ ] **Step 3: Report** — summarize verification results honestly; if any step failed, fix before claiming done.

---

## Self-Review (completed)

1. **Spec coverage:** close records → T1/T2; sweep visibility → T3; lifecycle module → T4; controller → T5; pill rungs incl. needs-address prompt → T6; onboarding fix → T7; channels/home/get-channel surfaces → T6/T8; history rows → T9; tests per spec → each task + T10. Deferred per spec: lease heads-up, per-close detail screen.
2. **Placeholders:** none — every code step has complete code; line anchors given for insertions.
3. **Type consistency:** `ChannelCloseRecord/ChannelCloseReason` (T1) consumed by T2/T5/T9; `SweepStatus` shape `{needsAddress, pendingCount, pendingSat, lastSweep?}` used identically in T3/T5/T6/T8; `ChannelLifecycle` string union identical in T4/T6; `groupByDay` generic signature matches T9 usage. Spec deviation (`"force-closed"` sixth label) is declared in Global Constraints.
