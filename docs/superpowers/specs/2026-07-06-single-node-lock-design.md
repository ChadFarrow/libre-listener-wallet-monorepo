# Single-Node Lock (one LDK node per origin)

**Date:** 2026-07-06
**Status:** Design — approved for planning
**Packages:** `@libre/shared`, `@libre/listener-wallet`, and the three frontends.

## Motivation

Running two LDK nodes with the same seed against the same storage corrupts channel state (each advances independently, they clobber each other's monitor writes → the loaded state regresses → Layer A halts one, or a channel force-closes). The concrete local instance of this is **within one origin**: the PWA (`wallet-pwa`) and `example-app` each construct and `start()` a `LibreListenerWallet` in **two** contexts on the same IndexedDB — the page controller and the service worker (which runs a node for offline NWC). Nothing today prevents both running at once (confirmed: no `navigator.locks`/heartbeat/leader anywhere).

Layer C removed the *offscreen-reap* fund-loss path, but not this concurrent-instance one. This spec adds a **single-node lock** so at most one node runs per origin.

Out of scope (cannot be solved locally): the extension vs PWA vs phone case — different origins/devices share no lock or storage. That stays a documented "run one instance" discipline.

## Design

Enforce the invariant in the **SDK** via dependency injection (SDK stays platform-agnostic — never imports `navigator`), backed by a **Web Locks** helper in `@libre/shared`.

### 1. `@libre/shared` — `single-node-lock.ts`
- `nodeLockName(dbName: string): string` → e.g. `"libre-node:" + dbName` (per-network DB → its own lock, so networks don't block each other).
- `acquireWebNodeLock(name: string, locks?: LockManager): Promise<(() => void) | null>`:
  - Resolves the lock manager from `locks ?? (globalThis.navigator?.locks)`. **If unavailable** (old/insecure context), return a **no-op release `() => {}`** — never block a legitimate start (best-effort on unsupported browsers).
  - Otherwise `locks.request(name, { ifAvailable: true }, (lock) => …)`: if `lock` is `null` (already held elsewhere), resolve the outer promise to **`null`**; if held, keep the lock alive with a pending promise and resolve the outer promise to a **`release()`** that settles it. `release()` must be idempotent.
  - Returns a Promise of `release | null`.

### 2. SDK (`@libre/listener-wallet`)
- `WalletConfig` (or constructor opts) gains optional **`acquireRunLock?: () => Promise<(() => void) | null>`**.
- In `start()`, **before any storage access** (first thing after the running/starting guards): if `acquireRunLock` is set, call it. If it returns `null` → **throw `NodeAlreadyRunningError`** (new class, exported from the barrel; carries a boundary-stable `code = "NODE_ALREADY_RUNNING"` mirrored in the message, same pattern as `ChannelStateRegressionError`, so it survives the extension's `chrome.runtime` error-flattening). If it returns a `release`, store it.
- On `stop()` — and in `start()`'s failure-cleanup catch (the half-built-wallet teardown) — call `release()` (idempotent) so a legit restart in the same context can re-acquire.
- No `navigator` import in the SDK. Mobile/RN simply doesn't inject `acquireRunLock`.

### 3. Frontends
Inject `acquireRunLock: () => acquireWebNodeLock(nodeLockName(dbNameForNetwork(network)))` wherever each builds the wallet, and handle `NodeAlreadyRunningError` via `@libre/shared`'s discriminator:
- **wallet-pwa** — page controller (`wallet-controller.ts` `buildWallet`/`doStartNode`) AND `service-worker.ts` node build. Page: on the error show a clear message ("This wallet is already running in another tab or window — close it and try again"). SW: on the error **skip offline processing silently** (the page holds the lock = the page is handling it). When the page closes, its lock auto-releases (Web Locks release on context destruction), so the SW can then acquire it.
- **example-app** — same page + service-worker structure; same two injection points + handling (`main.ts` start handler + `service-worker.ts`).
- **browser-extension** — inject in the offscreen host (`offscreen/wallet-host.ts` `buildWallet`). Belt-and-braces (already single-node); on the error, surface it like the other start errors.
- Add `isNodeAlreadyRunningError(e)` to `@libre/shared` (mirrors `isChannelStateRegressionError`) for the extension's string-only RPC boundary.

## Behavior

| Situation | Result |
|---|---|
| Only the page runs the node | page acquires lock, starts normally |
| Page open, SW woken for offline NWC | SW's `start()` → `null` → `NodeAlreadyRunningError` → SW skips (page handles it) |
| Page closed, SW woken | page's lock auto-released on close → SW acquires, runs offline |
| Two tabs of the same PWA | first holds the lock; second shows "already running in another tab" |
| `navigator.locks` unavailable | no-op release → starts (best-effort; unchanged from today) |
| Extension offscreen | acquires (nothing contends) — belt-and-braces |
| Extension vs PWA vs phone (cross-origin/device) | NOT guarded — documented discipline |

## Testing (TDD, no LDK mocking)

- **`@libre/shared`** unit: `acquireWebNodeLock` with an injected fake `LockManager` → returns a `release` when free; returns `null` when `ifAvailable` yields no lock; returns a no-op release when `locks` is undefined. `nodeLockName` shape. `isNodeAlreadyRunningError` (object `.code`, flattened message string, negatives).
- **SDK** unit (real LDK WASM, injected fake `acquireRunLock`): `start()` with an acquirer returning `null` throws `NodeAlreadyRunningError` and does NOT start (status not Running, no peer dial); with a release fn, `start()` succeeds and `stop()` calls `release` exactly once; a `start()` that throws downstream still releases the lock. `NodeAlreadyRunningError` carries the code + message token.
- **Frontends** (jsdom where they test): the page start-catch reveals the "already running" message on the error; the SW path skips on the error. Realistic to each package's existing test seams.

## Scope / non-goals
In scope: the shared helper, the SDK DI hook + error, the frontend injections + error handling, tests. Not in scope: cross-origin/cross-device detection, presence heartbeats, Layer B. No storage-format change; `check:storage` stays green.
