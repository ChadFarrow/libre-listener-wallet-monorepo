# Channel-State Regression Guard (Layer A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `LibreListenerWallet.start()` refuse to start (throw) when a loaded `ChannelMonitor` is behind a durably-recorded per-channel high-water mark, so a node that came back with regressed channel state halts for restore instead of reconnecting and getting force-closed.

**Architecture:** A pure high-water module tracks the max `ChannelMonitor.get_latest_update_id()` seen per channel, persisted under a non-critical `monitor_update_highwater` storage key. `start()` compares loaded monitors against it and throws `ChannelStateRegressionError` on a regression, *before* any peer connection. The mark advances during operation from the (shared-by-reference) loaded monitors and resets on `importState`.

**Tech Stack:** TypeScript, LDK WASM (`lightningdevkit@0.1.0`), Vitest (jsdom/node unit + docker integration), MSW for esplora.

## Global Constraints

- **TDD:** red → green → refactor; every production change lands with tests in the same task.
- **No LDK mocking:** use real LDK WASM; mock only network transport/HTTP (MSW). (`testing-strategy.md`)
- **No silent catches:** log via injected `Logger` and rethrow or return `{ok:false}`. (`project-conventions.md`)
- **No floating promises:** terminate fire-and-forget with `.catch(...)` (matches `index.ts:900`).
- **Barrel exports:** consumers import from package `index.ts`.
- **Files:** kebab-case; types PascalCase; functions camelCase.
- **The new marker is NON-critical:** not in the encrypted backup (`BACKUP_DIRECT_KEYS`), not a storage-contract invariant; a corrupt/absent marker must never throw or block startup.
- Test one file: `pnpm --filter @libre/listener-wallet exec vitest run <path>`.

---

## File Structure

- Create `packages/libre-listener-wallet/src/state-highwater.ts` — pure high-water logic + `ChannelStateRegressionError`. One responsibility: the regression-detection brain, zero LDK/storage deps.
- Create `packages/libre-listener-wallet/src/tests/unit/state-highwater.test.ts` — pure unit tests.
- Modify `packages/libre-listener-wallet/src/index.ts` — import helpers; add marker key + in-memory field; guard in `start()`; advance in the event-tick loop; clear in `importState`; barrel-export the error.
- Create `packages/libre-listener-wallet/src/tests/unit/state-regression-guard.test.ts` — WASM unit tests for the no-throw paths (fresh start, stale-entry-for-absent-channel, importState clears marker).
- Create `packages/libre-listener-wallet/src/tests/integration/state-regression-guard.test.ts` — docker test: funded channel → forced regression → `start()` throws + no peer dial.

---

### Task 1: Pure high-water module + error

**Files:**
- Create: `packages/libre-listener-wallet/src/state-highwater.ts`
- Test: `packages/libre-listener-wallet/src/tests/unit/state-highwater.test.ts`

**Interfaces:**
- Produces:
  - `type Highwater = Map<string, bigint>`
  - `interface MonitorSummary { channelId: string; latestUpdateId: bigint }`
  - `interface Regression { channelId: string; loaded: bigint; highwater: bigint }`
  - `parseHighwater(raw: string | null): Highwater`
  - `serializeHighwater(map: Highwater): string`
  - `mergeHighwater(stored: Highwater, summaries: MonitorSummary[]): Highwater`
  - `findRegression(summaries: MonitorSummary[], stored: Highwater): Regression | null`
  - `highwaterEquals(a: Highwater, b: Highwater): boolean`
  - `class ChannelStateRegressionError extends Error` (fields `channelId: string`, `loadedUpdateId: bigint`, `highwaterUpdateId: bigint`)

- [ ] **Step 1: Write the failing test**

Create `packages/libre-listener-wallet/src/tests/unit/state-highwater.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  parseHighwater,
  serializeHighwater,
  mergeHighwater,
  findRegression,
  highwaterEquals,
  ChannelStateRegressionError,
} from "../../state-highwater";

describe("parseHighwater", () => {
  it("returns empty map for null/empty", () => {
    expect(parseHighwater(null).size).toBe(0);
    expect(parseHighwater("").size).toBe(0);
  });
  it("parses decimal ids into bigints", () => {
    const m = parseHighwater('{"aa":"5","bb":"18446744073709551615"}');
    expect(m.get("aa")).toBe(5n);
    expect(m.get("bb")).toBe(18446744073709551615n);
  });
  it("degrades to empty on corrupt JSON (never throws — non-critical marker)", () => {
    expect(parseHighwater("not json").size).toBe(0);
  });
  it("skips a single bad entry without discarding the rest", () => {
    const m = parseHighwater('{"aa":"5","bb":"xyz"}');
    expect(m.get("aa")).toBe(5n);
    expect(m.has("bb")).toBe(false);
  });
});

describe("serializeHighwater round-trips", () => {
  it("survives parse(serialize(x))", () => {
    const m = new Map<string, bigint>([["aa", 5n], ["bb", 99n]]);
    expect(parseHighwater(serializeHighwater(m))).toEqual(m);
  });
});

describe("mergeHighwater", () => {
  it("takes the max per channel and adds new channels", () => {
    const stored = new Map<string, bigint>([["aa", 5n], ["bb", 10n]]);
    const merged = mergeHighwater(stored, [
      { channelId: "aa", latestUpdateId: 7n }, // advances
      { channelId: "bb", latestUpdateId: 9n }, // stays (lower ignored)
      { channelId: "cc", latestUpdateId: 1n }, // new
    ]);
    expect(merged.get("aa")).toBe(7n);
    expect(merged.get("bb")).toBe(10n);
    expect(merged.get("cc")).toBe(1n);
  });
  it("does not mutate the input", () => {
    const stored = new Map<string, bigint>([["aa", 5n]]);
    mergeHighwater(stored, [{ channelId: "aa", latestUpdateId: 9n }]);
    expect(stored.get("aa")).toBe(5n);
  });
});

describe("findRegression", () => {
  const stored = new Map<string, bigint>([["aa", 10n]]);
  it("flags a loaded monitor behind its high-water", () => {
    const r = findRegression([{ channelId: "aa", latestUpdateId: 3n }], stored);
    expect(r).toEqual({ channelId: "aa", loaded: 3n, highwater: 10n });
  });
  it("passes when loaded == high-water", () => {
    expect(findRegression([{ channelId: "aa", latestUpdateId: 10n }], stored)).toBeNull();
  });
  it("passes when loaded > high-water", () => {
    expect(findRegression([{ channelId: "aa", latestUpdateId: 11n }], stored)).toBeNull();
  });
  it("ignores a high-water entry with no loaded monitor (closed channel — no false halt)", () => {
    expect(findRegression([], stored)).toBeNull();
  });
});

describe("highwaterEquals", () => {
  it("true for equal maps, false otherwise", () => {
    expect(highwaterEquals(new Map([["a", 1n]]), new Map([["a", 1n]]))).toBe(true);
    expect(highwaterEquals(new Map([["a", 1n]]), new Map([["a", 2n]]))).toBe(false);
    expect(highwaterEquals(new Map([["a", 1n]]), new Map())).toBe(false);
  });
});

describe("ChannelStateRegressionError", () => {
  it("carries the channel + update ids and a restore-oriented message", () => {
    const e = new ChannelStateRegressionError({ channelId: "aa", loaded: 3n, highwater: 10n });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ChannelStateRegressionError");
    expect(e.channelId).toBe("aa");
    expect(e.loadedUpdateId).toBe(3n);
    expect(e.highwaterUpdateId).toBe(10n);
    expect(e.message).toMatch(/restore from a backup/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/state-highwater.test.ts`
Expected: FAIL — cannot resolve `../../state-highwater`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/libre-listener-wallet/src/state-highwater.ts`:

```typescript
// Monotonic per-channel high-water marks of ChannelMonitor.get_latest_update_id(), used to
// detect channel-state regression on load. A node that reloads channel state BEHIND a point it
// durably reached must halt (not reconnect + get force-closed). Pure: no LDK, no storage.

export type Highwater = Map<string, bigint>;

export interface MonitorSummary {
  channelId: string; // 32-byte channel id, hex
  latestUpdateId: bigint; // ChannelMonitor.get_latest_update_id()
}

export interface Regression {
  channelId: string;
  loaded: bigint;
  highwater: bigint;
}

/** Parse the persisted marker. A corrupt/absent marker degrades to empty — NEVER throws, so a
 *  non-critical, re-derivable marker can't block startup. */
export function parseHighwater(raw: string | null): Highwater {
  const map: Highwater = new Map();
  if (!raw) return map;
  let obj: Record<string, string>;
  try {
    obj = JSON.parse(raw) as Record<string, string>;
  } catch {
    return new Map();
  }
  for (const [k, v] of Object.entries(obj)) {
    try {
      map.set(k, BigInt(v));
    } catch {
      // skip a single malformed entry; keep the rest
    }
  }
  return map;
}

export function serializeHighwater(map: Highwater): string {
  const obj: Record<string, string> = {};
  for (const [k, v] of map) obj[k] = v.toString();
  return JSON.stringify(obj);
}

/** Monotonic merge: each channel's mark only ever increases; new channels are added. Pure. */
export function mergeHighwater(stored: Highwater, summaries: MonitorSummary[]): Highwater {
  const next: Highwater = new Map(stored);
  for (const s of summaries) {
    const cur = next.get(s.channelId);
    if (cur === undefined || s.latestUpdateId > cur) next.set(s.channelId, s.latestUpdateId);
  }
  return next;
}

/** A regression is a LOADED monitor whose update id is below its recorded high-water. A high-water
 *  entry with no loaded monitor is NOT a regression (a legitimately-closed channel), avoiding a
 *  false halt. */
export function findRegression(summaries: MonitorSummary[], stored: Highwater): Regression | null {
  for (const s of summaries) {
    const hw = stored.get(s.channelId);
    if (hw !== undefined && s.latestUpdateId < hw) {
      return { channelId: s.channelId, loaded: s.latestUpdateId, highwater: hw };
    }
  }
  return null;
}

export function highwaterEquals(a: Highwater, b: Highwater): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

export class ChannelStateRegressionError extends Error {
  readonly channelId: string;
  readonly loadedUpdateId: bigint;
  readonly highwaterUpdateId: bigint;
  constructor(r: Regression) {
    super(
      `Channel state regressed: channel ${r.channelId} loaded at monitor update ${r.loaded}, ` +
        `but this wallet durably reached ${r.highwater}. Refusing to start to avoid force-closing ` +
        `the channel — restore from a backup.`,
    );
    this.name = "ChannelStateRegressionError";
    this.channelId = r.channelId;
    this.loadedUpdateId = r.loaded;
    this.highwaterUpdateId = r.highwater;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/state-highwater.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/libre-listener-wallet/src/state-highwater.ts packages/libre-listener-wallet/src/tests/unit/state-highwater.test.ts
git commit -m "feat(sdk): pure channel-state high-water + regression detection (Layer A brain)"
```

---

### Task 2: Wire the guard into the wallet

**Files:**
- Modify: `packages/libre-listener-wallet/src/index.ts` (barrel export ~line 100 area; new key const near other storage keys; new field near `stateVersion` ~line 334; guard in the monitor-load section ~line 510; advance call in the event-tick interval ~line 810; clear in `importState` ~line 1188)
- Test: `packages/libre-listener-wallet/src/tests/unit/state-regression-guard.test.ts`

**Interfaces:**
- Consumes: `parseHighwater`, `serializeHighwater`, `mergeHighwater`, `findRegression`, `highwaterEquals`, `ChannelStateRegressionError`, `type MonitorSummary`, `type Highwater` from `./state-highwater`; existing `bytesToHex` from `./storage-cache`.
- Produces: re-exported `ChannelStateRegressionError` from the package barrel; storage key `"monitor_update_highwater"`.

- [ ] **Step 1: Write the failing test**

Create `packages/libre-listener-wallet/src/tests/unit/state-regression-guard.test.ts`:

```typescript
// @vitest-environment node
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  LibreListenerWallet,
  SecureStorageProvider,
  WebSocketStreamProvider,
  ChannelStateRegressionError,
} from "../../index";
import * as fs from "fs";
import * as path from "path";

function loadWasmBinary(): Uint8Array {
  const paths = [
    path.resolve(__dirname, "../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(__dirname, "../../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "../../node_modules/lightningdevkit/liblightningjs.wasm"),
  ];
  for (const p of paths) if (fs.existsSync(p)) return fs.readFileSync(p);
  throw new Error("Could not find liblightningjs.wasm");
}

const esploraUrl = "https://mock-esplora.api";
const mswServer = setupServer(
  http.get(`${esploraUrl}/blocks/tip/height`, () => HttpResponse.text("0")),
  http.get(`${esploraUrl}/blocks/tip/hash`, () => HttpResponse.text("00".repeat(32))),
  http.get(`${esploraUrl}/block-height/:height`, () => HttpResponse.text("00".repeat(32))),
  http.get(`${esploraUrl}/block/:hash/header`, () => HttpResponse.text("00".repeat(80))),
  http.get(`${esploraUrl}/fee-estimates`, () => HttpResponse.json({ "1": 10, "6": 5, "144": 1 })),
);
const noSocket: WebSocketStreamProvider = { connect: async () => { throw new Error("not used"); } };
function makeStorage(db: Map<string, string>): SecureStorageProvider {
  return {
    getItem: async (k) => db.get(k) ?? null,
    setItem: async (k, v) => { db.set(k, v); },
    removeItem: async (k) => { db.delete(k); },
  };
}
const HW_KEY = "monitor_update_highwater";

describe("channel-state regression guard", () => {
  let wasmBinary: Uint8Array;
  beforeAll(() => { wasmBinary = loadWasmBinary(); mswServer.listen({ onUnhandledRequest: "bypass" }); });
  afterEach(() => mswServer.resetHandlers());
  afterAll(() => mswServer.close());

  it("fresh wallet starts and writes an (empty) marker — export omits it", async () => {
    const db = new Map<string, string>();
    const wallet = new LibreListenerWallet({ config: { network: "regtest", esploraUrl }, storage: makeStorage(db), socketProvider: noSocket, wasmBinary });
    await wallet.start();
    expect(wallet.status()).toBe("Running");
    expect(db.get(HW_KEY)).toBe("{}");
    const blob = await wallet.exportState();
    // marker is non-critical → must NOT be in the backup
    const { decryptAndParse } = await import("../../state-backup");
    const payload = await decryptAndParse(blob, db.get("ldk_seed")!);
    expect(payload.entries[HW_KEY]).toBeUndefined();
    await wallet.stop();
  });

  it("does NOT false-halt on a high-water entry for a channel with no loaded monitor", async () => {
    const db = new Map<string, string>();
    db.set(HW_KEY, JSON.stringify({ [("aa".repeat(32))]: "9" })); // stale entry, no such monitor
    const wallet = new LibreListenerWallet({ config: { network: "regtest", esploraUrl }, storage: makeStorage(db), socketProvider: noSocket, wasmBinary });
    await expect(wallet.start()).resolves.toBeUndefined();
    expect(wallet.status()).toBe("Running");
    await wallet.stop();
  });

  it("importState clears any stale marker (a restore is authoritative)", async () => {
    // Produce a real slim backup from a fresh wallet.
    const dbA = new Map<string, string>();
    const walletA = new LibreListenerWallet({ config: { network: "regtest", esploraUrl }, storage: makeStorage(dbA), socketProvider: noSocket, wasmBinary });
    await walletA.start();
    const seed = dbA.get("ldk_seed")!;
    const blob = await walletA.exportState();
    await walletA.stop();

    const dbB = new Map<string, string>();
    dbB.set(HW_KEY, JSON.stringify({ [("bb".repeat(32))]: "42" })); // stale marker in destination
    const walletB = new LibreListenerWallet({ config: { network: "regtest", esploraUrl }, storage: makeStorage(dbB), socketProvider: noSocket, wasmBinary });
    await walletB.importState(blob, seed);
    expect(dbB.get(HW_KEY)).toBeUndefined(); // cleared by importState
    await walletB.start(); // and no regression on the restored (empty) monitor set
    expect(walletB.status()).toBe("Running");
    await walletB.stop();
  });

  it("exports the error type from the barrel", () => {
    expect(typeof ChannelStateRegressionError).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/state-regression-guard.test.ts`
Expected: FAIL — `ChannelStateRegressionError` not exported and marker not written (`db.get(HW_KEY)` undefined).

- [ ] **Step 3a: Add imports, key const, field, and barrel export in `index.ts`**

Near the existing `import { BACKUP_DIRECT_KEYS } from "./backup-keys";` (index.ts:104), add:

```typescript
import {
  parseHighwater,
  serializeHighwater,
  mergeHighwater,
  findRegression,
  highwaterEquals,
  ChannelStateRegressionError,
  type Highwater,
} from "./state-highwater";
export { ChannelStateRegressionError } from "./state-highwater";
```

Add the storage key constant near the other module-level string keys (e.g. just above the class, near `PEER_ADDRESS_BOOK_KEY` ~line 260):

```typescript
// Per-channel high-water of ChannelMonitor.get_latest_update_id(). Non-critical (re-derivable,
// NOT in the encrypted backup): drives the channel-state regression guard. See state-highwater.ts.
const MONITOR_HIGHWATER_KEY = "monitor_update_highwater";
```

Add the in-memory field near `private stateVersion: number = 0;` (index.ts:334):

```typescript
  private monitorHighwater: Highwater = new Map();
  private loadedMonitors: import("lightningdevkit").ChannelMonitor[] = [];
```

- [ ] **Step 3b: Add the guard in the monitor-load section**

In `start()`, immediately AFTER the monitor-registration block that ends at `index.ts:511` (the `}` closing `if (monitorsReadRes.is_ok())`), and BEFORE the `// 8. Load or construct NetworkGraph & Scorer` comment, insert:

```typescript
    // Channel-state regression guard (Layer A). Refuse to start if any loaded monitor is BEHIND a
    // point this wallet durably reached — reconnecting stale channel state makes the peer force-close
    // it (2026-07-06 mainnet incident). Halting sends the user to restore-from-backup instead. Runs
    // BEFORE PeerManager/redial setup, so a regressed node never dials or reestablishes.
    this.loadedMonitors = channelMonitors;
    const storedHighwater = parseHighwater(await this.storage.getItem(MONITOR_HIGHWATER_KEY));
    const summaries = channelMonitors.map((m) => ({
      channelId: bytesToHex(m.channel_id().get_a()),
      latestUpdateId: m.get_latest_update_id(),
    }));
    const regression = findRegression(summaries, storedHighwater);
    if (regression) {
      this.logger?.error(
        `[Guard] Channel-state regression on ${regression.channelId}: loaded update ${regression.loaded} < high-water ${regression.highwater}. Refusing to start.`,
      );
      throw new ChannelStateRegressionError(regression);
    }
    this.monitorHighwater = mergeHighwater(storedHighwater, summaries);
    this.storage
      .setItem(MONITOR_HIGHWATER_KEY, serializeHighwater(this.monitorHighwater))
      .catch((e) => this.logger?.error(`Failed to persist ${MONITOR_HIGHWATER_KEY}: ${e instanceof Error ? e.message : e}`));
```

(`bytesToHex` is already imported in `index.ts`. `ChannelMonitor` is already imported for the `channelMonitors` typing.)

- [ ] **Step 3c: Advance the mark in the event-tick loop**

In the `eventTickIntervalId` interval, right after the channel-manager persist block (after `index.ts:810`, inside the same `if (this.channelManager) { ... }` or just after it — place it after the `}` that closes the `get_and_clear_needs_persistence()` block), add:

```typescript
        this.advanceMonitorHighwater();
```

Add the private method near `notifyStateChanged()` (~index.ts:897):

```typescript
  /** Advance the persisted per-channel high-water from the live (shared-by-reference) monitors.
   *  Monotonic + best-effort. Covers every channel present at start; channels opened mid-session
   *  are picked up on the next start when their monitors load. */
  private advanceMonitorHighwater(): void {
    if (this.loadedMonitors.length === 0) return;
    const summaries = this.loadedMonitors.map((m) => ({
      channelId: bytesToHex(m.channel_id().get_a()),
      latestUpdateId: m.get_latest_update_id(),
    }));
    const merged = mergeHighwater(this.monitorHighwater, summaries);
    if (highwaterEquals(merged, this.monitorHighwater)) return;
    this.monitorHighwater = merged;
    this.storage
      .setItem(MONITOR_HIGHWATER_KEY, serializeHighwater(merged))
      .catch((e) => this.logger?.error(`Failed to persist ${MONITOR_HIGHWATER_KEY}: ${e instanceof Error ? e.message : e}`));
  }
```

- [ ] **Step 3d: Clear the mark in `importState`**

In `importState`, after the seed is written (after `index.ts:1196`, before the closing `}` of the method), add:

```typescript
    // A restore is authoritative: drop any stale high-water in the destination storage so a
    // marker from a prior/other wallet can't false-halt the restored (possibly lower) monitors.
    // The next start() re-initializes the mark from the restored monitors.
    await this.storage.removeItem(MONITOR_HIGHWATER_KEY);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/state-regression-guard.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Run the full unit suite + lint to check nothing regressed**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit && pnpm --filter @libre/listener-wallet lint`
Expected: PASS, 0 lint errors (watch `no-floating-promises` on the new `.setItem(...).catch(...)` calls — they are terminated with `.catch`, matching `index.ts:900`).

- [ ] **Step 6: Commit**

```bash
git add packages/libre-listener-wallet/src/index.ts packages/libre-listener-wallet/src/tests/unit/state-regression-guard.test.ts
git commit -m "feat(sdk): halt start() on channel-state regression (Layer A guard)"
```

---

### Task 3: Docker integration test — end-to-end throw with a real monitor

**Files:**
- Create: `packages/libre-listener-wallet/src/tests/integration/state-regression-guard.test.ts`

**Interfaces:**
- Consumes: the funded-wallet + channel-open harness pattern from `tests/integration/recovery.test.ts` (docker regtest: `libre-bitcoind`, `libre-lnd`, esplora `:3002`, LSP `:9099`). Reuse its `runCmd`, `loadWasmBinary`, `TCPStreamProvider`, and MSW esplora wiring.

**Prerequisite:** `docker compose up -d` (regtest stack), same as the other integration tests.

- [ ] **Step 1: Write the test**

Create `packages/libre-listener-wallet/src/tests/integration/state-regression-guard.test.ts`. Copy the harness preamble from `recovery.test.ts` (the `runCmd`, `loadWasmBinary`, `TCPStreamProvider`, `mswServer` block, and its channel-funding helper), then the test body:

```typescript
// @vitest-environment node
// Proves the channel-state regression guard: after a channel is funded and the wallet has recorded
// a monitor-update high-water, a wallet that reloads with a high-water ABOVE the loaded monitor's
// update id (a durable-state regression) refuses to start — instead of reconnecting and being
// force-closed. Requires `docker compose up -d`.
//
// (Preamble — runCmd/loadWasmBinary/TCPStreamProvider/mswServer/fundChannel — copied from recovery.test.ts.)

import { ChannelStateRegressionError } from "../../index";

const HW_KEY = "monitor_update_highwater";

describe("regression guard (integration)", () => {
  it("halts start() when the high-water is ahead of the loaded monitor", async () => {
    // 1. Bring up a funded wallet over an in-memory storage Map, open a channel to the LSP/lnd,
    //    let it sync so the monitor persists and the high-water advances. (Use the recovery.test.ts
    //    channel-funding helper; keep the backing `Map<string,string>` as `db`.)
    const db = new Map<string, string>();
    const wallet = await fundChannel(db); // helper: opens + confirms a channel, returns a started wallet
    // sanity: the guard recorded a high-water for the channel
    const recorded = JSON.parse(db.get(HW_KEY)!);
    const [channelId, updateIdStr] = Object.entries(recorded)[0] as [string, string];
    expect(BigInt(updateIdStr)).toBeGreaterThan(0n);
    await wallet.stop();

    // 2. Simulate a durable regression: the monitor blob on disk is now BEHIND the high-water.
    //    Bump the stored high-water above the monitor's real update id (equivalent to the monitor
    //    blob rolling back below the mark).
    recorded[channelId] = (BigInt(updateIdStr) + 5n).toString();
    db.set(HW_KEY, JSON.stringify(recorded));

    // 3. A new wallet over the same storage must REFUSE to start.
    const revived = makeWalletOverStorage(db); // helper: new LibreListenerWallet with the same `db` + TCPStreamProvider
    await expect(revived.start()).rejects.toBeInstanceOf(ChannelStateRegressionError);
    expect(revived.status()).not.toBe("Running");
  }, 120_000);
});
```

Implement the two small helpers inline using the recovery.test.ts primitives:
- `fundChannel(db)`: construct a `LibreListenerWallet` with `config { network: "regtest", esploraUrl: "http://127.0.0.1:3002" }`, `TCPStreamProvider`, wasm; `start()`; connect + open a channel via the existing LSP/lnd flow used in `recovery.test.ts`; mine/confirm; poll `wallet.getChannels()` until `isChannelReady`; return the started wallet (its `db` already holds `monitor_update_highwater`).
- `makeWalletOverStorage(db)`: `new LibreListenerWallet({ config, storage: <Map-backed provider over db>, socketProvider: new TCPStreamProvider(), wasmBinary })`.

- [ ] **Step 2: Run the test**

Run: `docker compose up -d && pnpm --filter @libre/listener-wallet exec vitest run src/tests/integration/state-regression-guard.test.ts`
Expected: PASS — `start()` rejects with `ChannelStateRegressionError`; status not Running.

- [ ] **Step 3: Commit**

```bash
git add packages/libre-listener-wallet/src/tests/integration/state-regression-guard.test.ts
git commit -m "test(sdk): integration — regression guard halts start() on a funded channel"
```

---

## Self-Review

**Spec coverage:**
- Signal = monitor `get_latest_update_id()` (not `state_version`) → Task 1 `MonitorSummary`/`findRegression`, Task 2 guard. ✓
- Persisted `monitor_update_highwater` map, monotonic, non-backup/non-contract → Task 1 `mergeHighwater`, Task 2 key const + `exportState`-omits assertion. ✓
- Advance during operation in the event-tick loop → Task 2 Step 3c. ✓
- Guard on load throws before peer setup → Task 2 Step 3b (inserted at ~line 511, before PeerManager ~663). ✓
- Restore resets marker → Task 2 Step 3d. ✓
- Legacy/no-marker → initializes (empty stored → merge → write); covered by Task 2 fresh-start test. ✓
- Corrupt marker never blocks startup → Task 1 `parseHighwater` degrade-to-empty test. ✓
- Behavior matrix rows: normal (Task 2 fresh start), catastrophic (Task 3 integration), closed-channel no-false-halt (Task 1 + Task 2 stale-entry test), restore reset (Task 2). ✓
- Tests assert outcomes (throw vs started, marker values, no-Running), real LDK WASM, no LDK mocking. ✓

**Placeholder scan:** Task 3 references the `recovery.test.ts` harness rather than repeating ~120 lines of docker plumbing verbatim, and names the two helpers with explicit responsibilities — acceptable because the source file is cited and its primitives are concrete. All code steps show real code. No TBD/TODO.

**Type consistency:** `MonitorSummary { channelId: string; latestUpdateId: bigint }`, `Highwater = Map<string, bigint>`, `findRegression(summaries, stored)` used identically in Tasks 1 and 2. `bytesToHex(m.channel_id().get_a())` matches the verified `ChannelId.get_a(): Uint8Array`. `get_latest_update_id(): bigint` used directly (no conversion). Key `"monitor_update_highwater"` identical across Task 2 code and both test files' `HW_KEY`.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-06-channel-state-regression-guard.md`.
