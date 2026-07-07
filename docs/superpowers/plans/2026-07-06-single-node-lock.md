# Single-Node Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee one running LDK node per origin — via a `navigator.locks` lock injected into the SDK — so a frontend's page node and service-worker node can't both run against the same IndexedDB.

**Architecture:** A Web-Locks helper in `@libre/shared`; the SDK acquires an injected `acquireRunLock` at the top of `start()` (throws `NodeAlreadyRunningError` if held elsewhere) and releases on `stop()`/failure; each frontend injects the helper and handles the error. SDK stays platform-agnostic (no `navigator` import).

**Tech Stack:** TypeScript, Web Locks API, LDK WASM, Vitest (jsdom/node).

## Global Constraints

- TDD; no LDK mocking (real WASM; inject a fake `acquireRunLock`/`LockManager` — not LDK-mocking).
- No floating promises; no silent catches (log via Logger) — EXCEPT the SW deliberately skips silently on `NodeAlreadyRunningError` (the page owns the node).
- SDK never imports `navigator` — the lock is injected via constructor options.
- Discriminator code `NODE_ALREADY_RUNNING` mirrored in the error message (survives the extension's `chrome.runtime` error-flattening), mirroring `@libre/shared` `channel-regression.ts`.
- No storage-format change; `pnpm check:storage` stays green.
- Test one file: `pnpm --filter <pkg> exec vitest run <path>`.

---

## File Structure
- Create `packages/shared/src/single-node-lock.ts` — `nodeLockName`, `acquireWebNodeLock`, `NODE_ALREADY_RUNNING_CODE`, `isNodeAlreadyRunningError`.
- Create `packages/libre-listener-wallet/src/node-lock-error.ts` — `NodeAlreadyRunningError`.
- Modify `packages/libre-listener-wallet/src/index.ts` — constructor option `acquireRunLock`; acquire in `start()`; release in `stop()`/failure; barrel-export the error.
- Modify the 5 frontend node-build sites + their start-error handling.

---

### Task 1: `@libre/shared` — Web-Locks helper + discriminator

**Files:**
- Create: `packages/shared/src/single-node-lock.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from "./single-node-lock";`)
- Test: `packages/shared/src/single-node-lock.test.ts`

**Interfaces:**
- Produces: `nodeLockName(dbName: string): string`; `type LockRelease = () => void`; `acquireWebNodeLock(name: string, locks?: LockManager): Promise<LockRelease | null>`; `NODE_ALREADY_RUNNING_CODE`; `isNodeAlreadyRunningError(e: unknown): boolean`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/single-node-lock.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import {
  nodeLockName,
  acquireWebNodeLock,
  NODE_ALREADY_RUNNING_CODE,
  isNodeAlreadyRunningError,
} from "./index";

// Minimal fake of the Web Locks LockManager.request(name, {ifAvailable}, cb).
function fakeLocks(available: boolean) {
  return {
    request: (_name: string, _opts: any, cb: (lock: unknown) => any) => {
      // ifAvailable: when unavailable, the browser invokes cb(null).
      const r = cb(available ? { name: _name } : null);
      return Promise.resolve(r).then(() => undefined);
    },
  } as unknown as LockManager;
}

describe("nodeLockName", () => {
  it("namespaces by db name", () => {
    expect(nodeLockName("libre-wallet-mainnet")).toBe("libre-node:libre-wallet-mainnet");
  });
});

describe("acquireWebNodeLock", () => {
  it("returns a release fn when the lock is free", async () => {
    const release = await acquireWebNodeLock("n", fakeLocks(true));
    expect(typeof release).toBe("function");
    release!(); // idempotent — must not throw
    release!();
  });
  it("returns null when the lock is already held", async () => {
    expect(await acquireWebNodeLock("n", fakeLocks(false))).toBeNull();
  });
  it("degrades to a no-op release when Web Locks is unavailable", async () => {
    const release = await acquireWebNodeLock("n", undefined);
    expect(typeof release).toBe("function"); // never blocks a legit start
  });
});

describe("isNodeAlreadyRunningError", () => {
  it("matches an object by .code and a flattened message string", () => {
    expect(isNodeAlreadyRunningError({ code: NODE_ALREADY_RUNNING_CODE })).toBe(true);
    expect(isNodeAlreadyRunningError(`[${NODE_ALREADY_RUNNING_CODE}] running elsewhere`)).toBe(true);
    expect(isNodeAlreadyRunningError({ message: `[${NODE_ALREADY_RUNNING_CODE}] x` })).toBe(true);
  });
  it("does not match unrelated values", () => {
    expect(isNodeAlreadyRunningError(new Error("boom"))).toBe(false);
    expect(isNodeAlreadyRunningError(null)).toBe(false);
    expect(isNodeAlreadyRunningError({ code: "OTHER" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @libre/shared exec vitest run src/single-node-lock.test.ts`
Expected: FAIL — module unresolved.

- [ ] **Step 3: Implement `single-node-lock.ts`**

```typescript
// One LDK node per origin. A Web Lock held for the node's whole lifetime; a second context in the
// SAME origin (e.g. a PWA's page vs its service worker) that tries to start gets null → must not run.
// Lives in @libre/shared (browser util) so all frontends share it; the SDK stays navigator-free and
// receives the acquirer by injection. Cross-origin/device is NOT covered (no shared lock exists).

export type LockRelease = () => void;

export const NODE_ALREADY_RUNNING_CODE = "NODE_ALREADY_RUNNING";

export function nodeLockName(dbName: string): string {
  return `libre-node:${dbName}`;
}

export function isNodeAlreadyRunningError(e: unknown): boolean {
  if (e == null) return false;
  if (typeof e === "string") return e.includes(NODE_ALREADY_RUNNING_CODE);
  if (typeof e === "object") {
    if ((e as { code?: unknown }).code === NODE_ALREADY_RUNNING_CODE) return true;
    const msg = (e as { message?: unknown }).message;
    return typeof msg === "string" && msg.includes(NODE_ALREADY_RUNNING_CODE);
  }
  return false;
}

/** Acquire the per-origin node lock. Resolves to a release fn (lock held until called), or null if
 *  another context in this origin already holds it. If Web Locks is unavailable, or the request
 *  errors, degrade to a no-op release — never block a legitimate start (best-effort guard). */
export function acquireWebNodeLock(
  name: string,
  locks: LockManager | undefined = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks,
): Promise<LockRelease | null> {
  if (!locks || typeof (locks as LockManager).request !== "function") {
    return Promise.resolve<LockRelease>(() => {});
  }
  return new Promise<LockRelease | null>((resolveOuter) => {
    let settled = false;
    const settle = (v: LockRelease | null) => { if (!settled) { settled = true; resolveOuter(v); } };
    Promise.resolve(
      locks.request(name, { ifAvailable: true }, (lock) => {
        if (!lock) { settle(null); return; }               // held elsewhere in this origin
        return new Promise<void>((releaseInner) => settle(() => releaseInner())); // hold until release()
      }),
    ).catch(() => settle(() => {})); // request errored → don't block; no-op release
  });
}
```

- [ ] **Step 4: Barrel export + run test to verify it passes**

Add to `packages/shared/src/index.ts` (near the other `export *`): `export * from "./single-node-lock";`

Run: `pnpm --filter @libre/shared exec vitest run src/single-node-lock.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Build shared (SDK/frontends resolve its dist) + commit**

Run: `pnpm --filter @libre/shared build && pnpm --filter @libre/shared lint`
Expected: build OK, 0 lint errors.

```bash
git add packages/shared/src/single-node-lock.ts packages/shared/src/single-node-lock.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): per-origin node lock helper + NodeAlreadyRunning discriminator"
```

---

### Task 2: SDK — `NodeAlreadyRunningError` + `acquireRunLock` wiring

**Files:**
- Create: `packages/libre-listener-wallet/src/node-lock-error.ts`
- Modify: `packages/libre-listener-wallet/src/index.ts` (constructor opts ~383-399; fields near `isRunning` ~333; `start()` ~401-405; `stop()` end ~1221; barrel export)
- Test: `packages/libre-listener-wallet/src/tests/unit/single-node-lock.test.ts`

**Interfaces:**
- Consumes: `NODE_ALREADY_RUNNING_CODE` from `@libre/shared`.
- Produces: `NodeAlreadyRunningError` (exported from the SDK barrel); constructor option `acquireRunLock?: () => Promise<(() => void) | null>`.

- [ ] **Step 1: Write the failing test**

Create `packages/libre-listener-wallet/src/tests/unit/single-node-lock.test.ts` (mirror the harness in `state-regression-guard.test.ts` — WASM binary, MSW esplora at tip 0, `makeStorage`, `noSocket`):

```typescript
// @vitest-environment node
import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { LibreListenerWallet, SecureStorageProvider, WebSocketStreamProvider, NodeAlreadyRunningError } from "../../index";
import * as fs from "fs";
import * as path from "path";

function loadWasmBinary(): Uint8Array {
  const paths = [
    path.resolve(__dirname, "../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "../../node_modules/lightningdevkit/liblightningjs.wasm"),
  ];
  for (const p of paths) if (fs.existsSync(p)) return fs.readFileSync(p);
  throw new Error("wasm not found");
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
  return { getItem: async (k) => db.get(k) ?? null, setItem: async (k, v) => { db.set(k, v); }, removeItem: async (k) => { db.delete(k); } };
}

describe("single-node lock (acquireRunLock)", () => {
  let wasmBinary: Uint8Array;
  beforeAll(() => { wasmBinary = loadWasmBinary(); mswServer.listen({ onUnhandledRequest: "bypass" }); });
  afterEach(() => mswServer.resetHandlers());
  afterAll(() => mswServer.close());

  it("throws NodeAlreadyRunningError and does not start when the lock is held", async () => {
    const acquireRunLock = vi.fn().mockResolvedValue(null); // held elsewhere
    const wallet = new LibreListenerWallet({ config: { network: "regtest", esploraUrl }, storage: makeStorage(new Map()), socketProvider: noSocket, wasmBinary, acquireRunLock });
    await expect(wallet.start()).rejects.toBeInstanceOf(NodeAlreadyRunningError);
    expect(wallet.status()).not.toBe("Running");
    expect(acquireRunLock).toHaveBeenCalledTimes(1);
  });

  it("starts when the lock is free and releases it on stop", async () => {
    const release = vi.fn();
    const acquireRunLock = vi.fn().mockResolvedValue(release);
    const wallet = new LibreListenerWallet({ config: { network: "regtest", esploraUrl }, storage: makeStorage(new Map()), socketProvider: noSocket, wasmBinary, acquireRunLock });
    await wallet.start();
    expect(wallet.status()).toBe("Running");
    expect(release).not.toHaveBeenCalled();
    await wallet.stop();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the lock if start() fails after acquiring it", async () => {
    const release = vi.fn();
    const acquireRunLock = vi.fn().mockResolvedValue(release);
    // Force a downstream start failure: a stored channel_manager that fails to decode makes start() throw.
    const db = new Map<string, string>([["channel_manager", "00"], ["ldk_seed", "11".repeat(32)]]);
    const wallet = new LibreListenerWallet({ config: { network: "regtest", esploraUrl }, storage: makeStorage(db), socketProvider: noSocket, wasmBinary, acquireRunLock });
    await expect(wallet.start()).rejects.toBeTruthy();
    expect(release).toHaveBeenCalledTimes(1); // lock freed so a retry/fresh instance can acquire
  });

  it("NodeAlreadyRunningError carries the boundary-stable code + message token", () => {
    const e = new NodeAlreadyRunningError();
    expect(e.code).toBe("NODE_ALREADY_RUNNING");
    expect(e.message).toContain("NODE_ALREADY_RUNNING");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/single-node-lock.test.ts`
Expected: FAIL — `NodeAlreadyRunningError` not exported / `acquireRunLock` not honored.

- [ ] **Step 3a: Create the error + barrel export**

Create `packages/libre-listener-wallet/src/node-lock-error.ts`:

```typescript
import { NODE_ALREADY_RUNNING_CODE } from "@libre/shared";

// Thrown by start() when another context in this origin already holds the single-node lock. Code is
// mirrored in the message so it survives the extension's chrome.runtime error-flattening.
export class NodeAlreadyRunningError extends Error {
  readonly code = NODE_ALREADY_RUNNING_CODE;
  constructor() {
    super(
      `[${NODE_ALREADY_RUNNING_CODE}] This wallet is already running in another tab, window, or ` +
        `context. Close the other one and try again.`,
    );
    this.name = "NodeAlreadyRunningError";
  }
}
```

In `index.ts`, near the other local imports/exports (e.g. beside the `state-highwater` import/export block), add:
```typescript
import { NodeAlreadyRunningError } from "./node-lock-error";
export { NodeAlreadyRunningError } from "./node-lock-error";
```

- [ ] **Step 3b: Add the constructor option + fields**

In the constructor options type (`index.ts:383-390`), add after `wasmUrl?: string;`:
```typescript
    // Injected per-origin single-node lock acquirer. Returns a release fn, or null if another context
    // holds the lock (→ start() throws NodeAlreadyRunningError). Omitted on platforms without Web Locks.
    acquireRunLock?: () => Promise<(() => void) | null>;
```
In the constructor body (after `this.wasmUrl = options.wasmUrl;`, line 396):
```typescript
    this.acquireRunLock = options.acquireRunLock;
```
Add fields near `private isRunning: boolean = false;` (line 333):
```typescript
  private acquireRunLock?: () => Promise<(() => void) | null>;
  private releaseRunLock?: () => void;
```

- [ ] **Step 3c: Acquire in start(), wrap the body, release on failure**

In `start()` (index.ts:401-406), replace:
```typescript
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger?.warn("Wallet is already running");
      return;
    }
    this.logger?.info(`Starting LDK Node on network: ${this.config.network}`);
```
with:
```typescript
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger?.warn("Wallet is already running");
      return;
    }
    // Single-node lock: one LDK node per origin. Acquire BEFORE any storage access so two contexts
    // never open the same DB. Held for the node's lifetime; released on stop()/failure.
    if (this.acquireRunLock && !this.releaseRunLock) {
      const release = await this.acquireRunLock();
      if (!release) throw new NodeAlreadyRunningError();
      this.releaseRunLock = release;
    }
    try {
    this.logger?.info(`Starting LDK Node on network: ${this.config.network}`);
```
Then at the END of `start()` (immediately before the method's closing brace `}` that matches `async start()`), close the try and release on failure:
```typescript
    } catch (e) {
      // A failed start must free the lock, or a retry/fresh instance in this context self-deadlocks.
      this.releaseRunLock?.();
      this.releaseRunLock = undefined;
      throw e;
    }
  }
```
(No need to re-indent the body — TS/ESLint here do not enforce indentation.)

- [ ] **Step 3d: Release in stop()**

In `stop()`, after the teardown completes (near where `this.isRunning = false;` is set, index.ts ~1221), add:
```typescript
    this.releaseRunLock?.();
    this.releaseRunLock = undefined;
```

- [ ] **Step 4: Run tests + build to verify pass**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/single-node-lock.test.ts && pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit && pnpm --filter @libre/listener-wallet build`
Expected: new file PASS (4 cases), full unit suite PASS, build OK.

- [ ] **Step 5: Lint + commit**

Run: `pnpm --filter @libre/listener-wallet lint`
Expected: 0 errors.

```bash
git add packages/libre-listener-wallet/src/node-lock-error.ts packages/libre-listener-wallet/src/index.ts packages/libre-listener-wallet/src/tests/unit/single-node-lock.test.ts
git commit -m "feat(sdk): single-node lock via injected acquireRunLock + NodeAlreadyRunningError"
```

---

### Task 3: Wire the lock into the three frontends

**Files (inject `acquireRunLock` at each node build; handle `NodeAlreadyRunningError`):**
- `packages/wallet-pwa/src/wallet-controller.ts:141` (page) + `packages/wallet-pwa/src/service-worker.ts:156` (SW) + `packages/wallet-pwa/src/views/home.ts` (start-catch message)
- `packages/example-app/src/main.ts:621` (page) + `packages/example-app/src/service-worker.ts:100` (SW) + `main.ts` start-catch message
- `packages/browser-extension/src/offscreen/wallet-host.ts:134` (offscreen build; error surfaces via existing start() error path)

**Interfaces:**
- Consumes: `acquireWebNodeLock`, `nodeLockName`, `isNodeAlreadyRunningError` (`@libre/shared`); `NodeAlreadyRunningError` (SDK); each package's `dbNameForNetwork(network)` (`core/storage-namespace.ts`).

- [ ] **Step 1: Inject `acquireRunLock` at each primary node-build site**

At each of the 5 sites above, add to the `new LibreListenerWallet({ … })` options (read each file to get the in-scope `network`/db name — each has `dbNameForNetwork` from `core/storage-namespace`):
```typescript
      acquireRunLock: () => acquireWebNodeLock(nodeLockName(dbNameForNetwork(network))),
```
Add the import `import { acquireWebNodeLock, nodeLockName } from "@libre/shared";` to each of those files. (In `wallet-host.ts` the network comes from `this.getConfig()`/`activeNetwork()` — use the same `network` already used for `dbNameForNetwork` there; in `service-worker.ts` files, the `activeNetwork` variable already computed for the DB.)

Do NOT inject into the transient import/verify wallet instances (`main.ts:1090`, `main.ts:1481`) — they run briefly for restore/verify and would self-contend with the primary node's lock.

- [ ] **Step 2: Handle the error — page shows a message, SW skips silently**

**wallet-pwa** `views/home.ts` start-catch: add a branch (before the generic `setMsg`), using the discriminator:
```typescript
    if (isNodeAlreadyRunningError(e)) {
      setMsg("msg", "This wallet is already running in another tab or window — close it and try again.", "err");
      return;
    }
```
(import `isNodeAlreadyRunningError` from `@libre/shared`.)

**wallet-pwa** `service-worker.ts` node-start catch (~line 193): branch FIRST:
```typescript
    if (isNodeAlreadyRunningError(err)) {
      console.log("[SW] App is open (holds the node lock) — skipping offline processing.");
      return; // page owns the node; do NOT show a fallback notification
    }
```

**example-app** `main.ts` start-catch (the failed-start `catch`): add the same `isNodeAlreadyRunningError` branch → `appendLog("[ERROR] This wallet is already running in another tab/window.", "error")` and skip teardown-that-would-imply-a-real-failure as appropriate. **example-app** `service-worker.ts` catch: same silent-skip branch as wallet-pwa's SW.

**browser-extension** `offscreen/wallet-host.ts`: `startNode()`'s existing catch already rethrows; no special handling needed there — the error's `[NODE_ALREADY_RUNNING]` message crosses the RPC boundary and the popup's generic `setMsg("msg", e.message, "err")` shows it. (Optional: `popup.ts` could branch on `isNodeAlreadyRunningError` for nicer copy, but not required — the message is already clear. Only add if trivial.)

- [ ] **Step 3: Focused test (wallet-pwa, jsdom) + build all**

Add a jsdom test to wallet-pwa mirroring its existing `home.test.ts`: stub the controller's `startNode` to reject with a `NodeAlreadyRunningError` (import from `@libre/listener-wallet`), invoke the start handler, and assert the "already running in another tab" message is shown (via `#msg`). (example-app's monolithic `main.ts` and the extension's node-env tests: rely on the shared discriminator test + SDK test, per each package's existing seams — do not contort them.)

Run:
```
pnpm --filter @libre/wallet-pwa exec vitest run && pnpm --filter @libre/wallet-pwa build
pnpm --filter @libre/example-app exec vitest run && pnpm --filter @libre/example-app build
pnpm --filter @libre/browser-extension exec vitest run && pnpm --filter @libre/browser-extension build
pnpm --filter @libre/browser-extension lint && pnpm --filter @libre/wallet-pwa lint && pnpm --filter @libre/example-app lint
```
Expected: all green, 0 lint errors, all three builds succeed.

- [ ] **Step 4: Commit**

```bash
git add packages/wallet-pwa packages/example-app packages/browser-extension
git commit -m "feat: inject per-origin single-node lock into all three frontends"
```

---

## Self-Review

**Spec coverage:** shared helper (`acquireWebNodeLock`/`nodeLockName`/discriminator) → Task 1 ✓. SDK DI hook + `NodeAlreadyRunningError` + acquire-before-storage + release-on-stop/failure → Task 2 ✓. Frontend injection (both PWA/example contexts + extension offscreen) + page-message/SW-skip handling → Task 3 ✓. No-op degrade when Web Locks absent → Task 1 helper + test ✓. No storage-format change → no monitor/backup keys touched; Task 3 `check:storage` unaffected ✓. Behavior table rows (page-only, page+SW, page-closed→SW, two tabs, extension, cross-device out-of-scope) → covered by the SDK enforcement + frontend handling; cross-device explicitly out of scope.

**Placeholder scan:** No TBD/TODO. Frontend per-site injection cites exact build-site line refs + the exact option line; the message/skip branches show complete code. The `main.ts`/`wallet-host.ts` network-variable resolution is described (read the in-scope `network`) rather than hardcoding a possibly-wrong line — acceptable since each file's `dbNameForNetwork(network)` usage is the anchor.

**Type consistency:** `acquireRunLock?: () => Promise<(() => void) | null>` identical in the SDK option (Task 2) and the injected `() => acquireWebNodeLock(...)` (Task 3, `acquireWebNodeLock` returns `Promise<LockRelease | null>` = `Promise<(() => void) | null>`). `NODE_ALREADY_RUNNING_CODE`/`NodeAlreadyRunningError`/`isNodeAlreadyRunningError` names consistent across Tasks 1-3. Lock name `libre-node:<dbName>` consistent.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-06-single-node-lock.md`.
