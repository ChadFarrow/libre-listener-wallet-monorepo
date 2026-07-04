# Bridge-to-LSP: allowlisted multi-target WebSocket bridge

**Date:** 2026-07-04
**Status:** Approved (design)

## Problem

A browser LDK node has no listening socket — it reaches Lightning peers only by dialing **out** through a WebSocket→TCP bridge. Today that bridge (`ws-bridge/`, on Railway) is a `websockify` proxy hardwired to **one** fixed target (`BRIDGE_TARGET=45.33.65.45:9735`, the default channel peer), and the browser transport (`ws-provider.ts` / `BrowserWebSocketStreamProvider`) **ignores the peer's `address:port`** and always dials that single bridge URL.

Consequence: the wallet can only ever reach the one node the bridge fronts. Buying inbound liquidity from a real LSP (Megalith `64.23.162.51:9735`, Olympus `45.79.192.236:9735`) fails at `create_order` with "not connected" — the browser has no way to open a BOLT8 connection to the LSP node. The same limitation blocks any manual channel-open to a coordinated peer.

### Key realization (drives the design)

Every channel the browser participates in requires the **browser to dial out first** — even "share your Node ID and have someone open a channel to you" requires the browser to already be an outbound-connected inbound peer (a browser node cannot be dialed in, pubkey or not). So the LSP flow and the manual-open flow are the *same mechanical shape*: **reach one specific known node's `host:port`; that node opens a channel back.** Neither needs the bridge to connect to *arbitrary* hosts, so **no open TCP proxy is required** — a small allowlist covers every realistic case, and truly custom peers use the existing "point the bridge URL at your own bridge" escape hatch.

## Design

**An allowlisted multi-target bridge.** Two coordinated changes:

1. **Transport passes the target it currently drops.** `connect(address, port)` builds `wss://<bridge>/?target=<address>:<port>` instead of dialing the bare bridge URL.
2. **Bridge reads the requested target and validates it against a small env-configured allowlist** (the two LSPs + the default channel peer), refusing anything else and any private/loopback/link-local address. It then proxies the WebSocket to that TCP target.

This yields "LSP **and** manual channel open through one bridge," safe by construction (no open-proxy surface), as a small change.

## Components

### 1. Bridge — `ws-bridge/` (rewrite `websockify` → Node ws↔tcp proxy)

Replace the Python `websockify` container with a small Node service so the allowlist logic is explicit, testable, and in the monorepo's language.

- **`ws-bridge/src/allowlist.ts`** (pure, unit-tested):
  - `parseTarget(raw: string): { host: string; port: number } | null` — parse `host:port`, reject malformed/out-of-range port. IPv4/DNS host; IPv6 literals unsupported (matches the existing transport limitation).
  - `isPrivateHost(host: string): boolean` — true for loopback/private/link-local/multicast IPv4 ranges (`127.`, `10.`, `192.168.`, `172.16–31.`, `169.254.`, `0.`, `224–239.`) and obvious non-public DNS (`localhost`). Defense-in-depth against an allowlist typo.
  - `isTargetAllowed(target: string, allowlist: Set<string>): boolean` — exact `host:port` membership in the allowlist AND not a private host.
- **`ws-bridge/src/server.ts`**: a `ws` `WebSocketServer` (no Express). On upgrade, read `?target=` from the request URL:
  - Missing `?target=` → fall back to `BRIDGE_TARGET` (backward compatibility: an old client that doesn't send a target still reaches the default peer).
  - Present → `isTargetAllowed(...)` against `BRIDGE_ALLOWLIST`; reject (close code 1008) if not allowed.
  - On accept: open a `net.Socket` to the target, pipe both directions (`ws.on("message") → socket.write`, `socket.on("data") → ws.send`), and tear down both on either side's close/error. Binary frames only.
- **Config (env):**
  - `BRIDGE_ALLOWLIST` — comma-separated `host:port` (e.g. `64.23.162.51:9735,45.79.192.236:9735,45.33.65.45:9735`). Operator-maintained; the LSP IPs come from each LSP's live `get_info` uris.
  - `BRIDGE_TARGET` — the no-`?target` fallback (kept = current default peer). Also implicitly allowed.
  - `PORT` — injected by Railway; TLS terminated by Railway (public endpoint stays `wss://`).
- **`ws-bridge/Dockerfile`**: `FROM node:20-slim`, install deps, `tsc` build to `dist/`, `CMD ["node","dist/server.js"]`. `railway.json` unchanged (Dockerfile build).

**Workspace membership.** `ws-bridge/` becomes a real workspace package so its tests/lint/build run in CI, but keeps its repo-root path so the Railway service root is unchanged. Add it to `pnpm-workspace.yaml`; add `ws-bridge/package.json` (`@libre/ws-bridge`, private; dep `ws`; devDeps `typescript`, `vitest`, `@types/ws`, `@types/node`; scripts `build`/`test`/`lint`/`start`), `tsconfig.json`, and `vitest.config.ts` (node env). The root `eslint.config.mjs` and `ci.yml` pipeline pick it up automatically. The bridge does **not** depend on `@libre/shared` — its allowlist logic is self-contained (the `bridgeTargetUrl` helper is consumed only by the browser transports).

### 2. Shared helper — `@libre/shared`

`bridgeTargetUrl(base: string, host: string, port: number): string` (pure, unit-tested) — append `target=host:port` to the bridge base, handling an existing query string and trailing slash correctly. Single source of truth so the three transport copies can't diverge on a funds-path detail.

### 3. Transport — append the target (3 copies)

Each already receives the real `host, port` from the SDK (`socketProvider.connect(host, port)` at `index.ts:1226`) and discards it. Change each to `new WebSocket(bridgeTargetUrl(bridgeBase, host, port))`:
- `packages/example-app/src/main.ts` — `BrowserWebSocketStreamProvider.connect`
- `packages/example-app/src/service-worker.ts` — the SW's inline provider
- `packages/browser-extension/src/core/ws-provider.ts` — `createWebSocketStreamProvider`

**Backward compatibility:** appending `?target=` is harmless against the *old* `websockify` bridge (it ignores the query and connects to its fixed target), so the default-peer path keeps working during rollout; only LSP/manual targets require the new bridge deployed.

## Data flow

```
browser LDK  --connect(64.23.162.51, 9735)-->  ws-provider
  ws-provider  --wss://bridge/?target=64.23.162.51:9735-->  ws-bridge (Railway TLS→ws)
    ws-bridge  --isTargetAllowed? yes-->  net.Socket → 64.23.162.51:9735 (Megalith)
      <==== bidirectional BOLT8 bytes ====>
Megalith opens a zero-conf/confirmed channel back over this peer link.
```

## Security

- **No open proxy.** The bridge connects only to exact `host:port` entries in `BRIDGE_ALLOWLIST`; everything else is refused. Private/loopback/link-local targets are refused even if mistakenly allowlisted (SSRF defense-in-depth), mirroring the gateway's `isSafeRelayUrl` philosophy.
- **Public LN ports only, by construction.** The allowlist holds real LN P2P endpoints; the bridge is never a general relay.
- **Per-connection teardown** prevents socket leaks; a cap on concurrent connections per remote IP (config `MAX_CONNS_PER_IP`, default e.g. 8) bounds resource abuse of the public endpoint.
- The bridge carries only BOLT8-encrypted Lightning transport bytes — no keys, no secrets (consistent with the zero-custody guardrail).

## Error handling

- Malformed/missing/disallowed target → close the WS with code 1008 (policy violation) and a short reason; the transport surfaces it as a connect failure (existing `socket.onerror` path), and the SDK's peer auto-reconnect backoff applies.
- Target TCP connect failure/refused → close the WS; same surfacing.
- No silent catches: the bridge logs each rejection reason (target + why) at info level.

## Testing (TDD)

- **Pure units:** `allowlist.test.ts` (`parseTarget` valid/invalid/port-range; `isPrivateHost` across ranges; `isTargetAllowed` allow/deny incl. private-in-allowlist) and shared `bridgeTargetUrl` (append with/without existing query, trailing slash).
- **Bridge integration (no mocking of the proxy):** start the real bridge against a local `net` echo server added to the allowlist; assert (a) an allowlisted target round-trips bytes, (b) a non-allowlisted target is closed 1008, (c) a private-host target in the allowlist is still refused, (d) missing `?target` falls back to `BRIDGE_TARGET`.
- **Transport:** assert each `connect(host, port)` opens a WebSocket to the `bridgeTargetUrl(...)`-built URL (spy on the URL passed to `WebSocket`).

## Deployment

- Rewritten bridge deploys to its **own** Railway service (unchanged separation from the gateway): `railway up -s ws-bridge`.
- Set `BRIDGE_ALLOWLIST=64.23.162.51:9735,45.79.192.236:9735,45.33.65.45:9735` and keep `BRIDGE_TARGET=45.33.65.45:9735` (fallback = default peer).
- No app env change: `VITE_MAINNET_BRIDGE` / `DEFAULT_MAINNET_BRIDGE` stay pointed at the same `wss://…railway.app` URL. `ws-bridge/README.md` updated with the allowlist + the append-`?target` chain.

## Out of scope

- Hoisting the three duplicated transport providers into a single shared module (the `bridgeTargetUrl` helper is the targeted DRY fix; full consolidation is a separate cleanup).
- IPv6 / onion (`.onion`) targets (existing transport already can't do them).
- Auto-syncing the bridge allowlist from `LSPS1_REST_PROVIDERS` / live `get_info` (allowlist stays operator-maintained env for now; a mismatch just means that LSP can't be reached until added).
- The actual LSPS2 (instant JIT) BOLT8 path — separate work; this bridge unblocks LSPS1 create_order + channel open.
```
