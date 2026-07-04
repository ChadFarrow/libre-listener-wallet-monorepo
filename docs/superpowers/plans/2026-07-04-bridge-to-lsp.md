# Bridge-to-LSP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the browser wallet reach more than one Lightning node by turning the fixed-target bridge into an allowlisted multi-target WebSocket→TCP proxy and teaching the browser transport to pass the target it currently drops.

**Architecture:** The transport appends `?target=host:port` to the bridge URL. A small Node `ws`↔`net` proxy (rewrite of the Python `websockify` in `ws-bridge/`) reads that target, validates it against an env allowlist (the two LSPs + the default peer) plus a private-range guard, and proxies only to allowed nodes. Backward-compatible: an old websockify ignores the query, so the default-peer path keeps working during rollout.

**Tech Stack:** TypeScript, Node `ws` + `node:net`, vitest, tsup/tsc, Docker (Railway).

## Global Constraints

- Package manager **pnpm** (`pnpm@10.10.0`); the repo is a Turborepo monorepo. Files: kebab-case; types PascalCase; functions/vars camelCase.
- **TDD mandatory** (red→green→refactor). Do NOT mock the proxy internals — the bridge integration test uses a real `node:net` echo server. Pure logic (`allowlist.ts`, `bridgeTargetUrl`) gets pure unit tests.
- **Never commit without human approval** (repo rule): the commit steps below are real, but pause for approval before running each `git commit`.
- Async-safety lint rules are **errors** (`no-floating-promises`, `no-misused-promises`) — mark fire-and-forget with `void`.
- The bridge carries only BOLT8-encrypted transport bytes — never keys/secrets (zero-custody guardrail).
- `@libre/shared` resolves from its built `dist/` for downstream packages — after editing `packages/shared/src`, run `pnpm --filter @libre/shared build` before dependents typecheck/test.
- IPv6/onion targets are out of scope (the transport already can't do them); IPv4/DNS host `host:port` only.

---

### Task 1: `bridgeTargetUrl` helper in `@libre/shared`

**Files:**
- Modify: `packages/shared/src/index.ts` (append the helper near the other exported utils)
- Test: `packages/shared/src/bridge-target-url.test.ts` (create)

**Interfaces:**
- Produces: `bridgeTargetUrl(base: string, host: string, port: number): string` — appends `target=host:port` (URL-encoded) to a bridge base URL, choosing `?`/`&` by whether `base` already has a query.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/bridge-target-url.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { bridgeTargetUrl } from "./index";

describe("bridgeTargetUrl", () => {
  it("appends target with ? when the base has no query", () => {
    expect(bridgeTargetUrl("wss://b.up.railway.app", "64.23.162.51", 9735)).toBe(
      "wss://b.up.railway.app?target=64.23.162.51%3A9735"
    );
  });
  it("appends target with & when the base already has a query", () => {
    expect(bridgeTargetUrl("wss://b/path?x=1", "1.2.3.4", 9735)).toBe(
      "wss://b/path?x=1&target=1.2.3.4%3A9735"
    );
  });
  it("keeps a trailing slash and works for ws:// dev bridges", () => {
    expect(bridgeTargetUrl("ws://127.0.0.1:8085/", "5.6.7.8", 9736)).toBe(
      "ws://127.0.0.1:8085/?target=5.6.7.8%3A9736"
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @libre/shared exec vitest run src/bridge-target-url.test.ts`
Expected: FAIL — `bridgeTargetUrl is not a function` / import has no such export.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/shared/src/index.ts`:

```ts
// Append the desired peer target (host:port) to a WebSocket bridge base URL. The multi-target
// ws-bridge reads ?target= and connects there; an old single-target websockify ignores the query,
// so the default-peer path stays backward-compatible during rollout.
export function bridgeTargetUrl(base: string, host: string, port: number): string {
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}target=${encodeURIComponent(`${host}:${port}`)}`;
}
```

- [ ] **Step 4: Run test to verify it passes, then rebuild shared**

Run: `pnpm --filter @libre/shared exec vitest run src/bridge-target-url.test.ts`
Expected: PASS (3 tests).
Then: `pnpm --filter @libre/shared build`
Expected: build success (dist regenerated so dependents see the new export).

- [ ] **Step 5: Commit** (pause for approval)

```bash
git add packages/shared/src/index.ts packages/shared/src/bridge-target-url.test.ts
git commit -m "feat(shared): bridgeTargetUrl helper to append ?target=host:port to the bridge URL"
```

---

### Task 2: `ws-bridge` package scaffold + allowlist logic

**Files:**
- Create: `ws-bridge/package.json`, `ws-bridge/tsconfig.json`, `ws-bridge/vitest.config.ts`
- Modify: `pnpm-workspace.yaml` (add `ws-bridge`)
- Create: `ws-bridge/src/allowlist.ts`
- Test: `ws-bridge/src/allowlist.test.ts`

**Interfaces:**
- Produces:
  - `parseTarget(raw: string): { host: string; port: number } | null`
  - `isPrivateHost(host: string): boolean`
  - `isTargetAllowed(raw: string, allowlist: Set<string>, opts?: { allowPrivate?: boolean }): boolean`

- [ ] **Step 1: Scaffold the package**

Create `ws-bridge/package.json`:

```json
{
  "name": "@libre/ws-bridge",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/main.js",
    "test": "vitest run",
    "lint": "eslint src"
  },
  "dependencies": {
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.10",
    "typescript": "^5.9.3",
    "vitest": "^1.6.1"
  }
}
```

Create `ws-bridge/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts", "dist"]
}
```

(CommonJS output — no `.js` import extensions needed, and it sidesteps the ESM/vitest resolution friction for a tiny Node service. `node dist/main.js` runs it directly.)

Create `ws-bridge/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["src/**/*.test.ts"] } });
```

Add `ws-bridge` to the packages list in `pnpm-workspace.yaml` (keep existing entries; add the line):

```yaml
  - "ws-bridge"
```

Run: `pnpm install`
Expected: workspace resolves `@libre/ws-bridge`; `ws` + dev deps install.

- [ ] **Step 2: Write the failing test**

Create `ws-bridge/src/allowlist.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseTarget, isPrivateHost, isTargetAllowed } from "./allowlist";

describe("parseTarget", () => {
  it("parses host:port", () => {
    expect(parseTarget("64.23.162.51:9735")).toEqual({ host: "64.23.162.51", port: 9735 });
  });
  it("rejects malformed / out-of-range", () => {
    for (const bad of ["", "nohost", "1.2.3.4:", "1.2.3.4:0", "1.2.3.4:70000", "1.2.3.4:abc"]) {
      expect(parseTarget(bad)).toBeNull();
    }
  });
});

describe("isPrivateHost", () => {
  it("flags loopback/private/link-local/multicast + localhost", () => {
    for (const h of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "172.31.255.255", "169.254.1.1", "224.0.0.1", "localhost", "::1"]) {
      expect(isPrivateHost(h)).toBe(true);
    }
  });
  it("passes public hosts", () => {
    for (const h of ["64.23.162.51", "45.79.192.236", "8.8.8.8", "172.32.0.1"]) {
      expect(isPrivateHost(h)).toBe(false);
    }
  });
});

describe("isTargetAllowed", () => {
  const list = new Set(["64.23.162.51:9735", "45.79.192.236:9735", "45.33.65.45:9735"]);
  it("allows an allowlisted public target", () => {
    expect(isTargetAllowed("64.23.162.51:9735", list)).toBe(true);
  });
  it("denies a non-allowlisted target", () => {
    expect(isTargetAllowed("1.2.3.4:9735", list)).toBe(false);
  });
  it("denies a private target even if allowlisted (SSRF guard)", () => {
    const l = new Set(["127.0.0.1:9999"]);
    expect(isTargetAllowed("127.0.0.1:9999", l)).toBe(false);
  });
  it("permits a private target only when allowPrivate is set (tests)", () => {
    const l = new Set(["127.0.0.1:9999"]);
    expect(isTargetAllowed("127.0.0.1:9999", l, { allowPrivate: true })).toBe(true);
  });
  it("denies malformed input", () => {
    expect(isTargetAllowed("garbage", list)).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @libre/ws-bridge exec vitest run src/allowlist.test.ts`
Expected: FAIL — cannot resolve `./allowlist`.

- [ ] **Step 4: Write minimal implementation**

Create `ws-bridge/src/allowlist.ts`:

```ts
// Target policy for the multi-target bridge. The bridge connects ONLY to exact host:port entries
// in the operator allowlist, and never to a private/loopback/link-local/multicast address (defense
// in depth against an allowlist typo). allowPrivate is a test-only escape hatch (loopback echo
// servers), mirroring the gateway's allowPrivateRelays.
export interface Target {
  host: string;
  port: number;
}

export function parseTarget(raw: string): Target | null {
  if (!raw) return null;
  const at = raw.lastIndexOf(":");
  if (at <= 0 || at === raw.length - 1) return null;
  const host = raw.slice(0, at);
  const port = Number(raw.slice(at + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

const PRIVATE_V4: RegExp[] = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^(22[4-9]|23\d)\./, // 224-239 multicast
];

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  return PRIVATE_V4.some((re) => re.test(h));
}

export function isTargetAllowed(
  raw: string,
  allowlist: Set<string>,
  opts: { allowPrivate?: boolean } = {}
): boolean {
  const t = parseTarget(raw);
  if (!t) return false;
  if (!opts.allowPrivate && isPrivateHost(t.host)) return false;
  return allowlist.has(`${t.host}:${t.port}`);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @libre/ws-bridge exec vitest run src/allowlist.test.ts`
Expected: PASS (all groups green).

- [ ] **Step 6: Commit** (pause for approval)

```bash
git add ws-bridge/package.json ws-bridge/tsconfig.json ws-bridge/vitest.config.ts ws-bridge/src/allowlist.ts ws-bridge/src/allowlist.test.ts pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(ws-bridge): scaffold package + allowlisted target policy (parseTarget/isPrivateHost/isTargetAllowed)"
```

---

### Task 3: bridge server (`startBridge`) + integration test + entry point

**Files:**
- Create: `ws-bridge/src/server.ts`, `ws-bridge/src/main.ts`
- Test: `ws-bridge/src/server.test.ts`

**Interfaces:**
- Consumes: `isTargetAllowed`, `parseTarget` (Task 2).
- Produces:
  - `interface BridgeConfig { port: number; allowlist: Set<string>; fallbackTarget?: string; allowPrivate?: boolean; maxConnsPerIp?: number; log?: (m: string) => void }`
  - `startBridge(cfg: BridgeConfig): { ready: Promise<number>; close: () => Promise<void> }` — `ready` resolves to the actually-bound port (supports `port: 0` in tests).

- [ ] **Step 1: Write the failing integration test**

Create `ws-bridge/src/server.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { WebSocket } from "ws";
import { startBridge } from "./server";

// A real TCP echo server (no mocking) the bridge proxies to.
function startEcho(): Promise<{ port: number; close: () => void }> {
  return new Promise((res) => {
    const srv = net.createServer((sock) => sock.pipe(sock));
    srv.listen(0, "127.0.0.1", () => res({ port: (srv.address() as net.AddressInfo).port, close: () => srv.close() }));
  });
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function connectWs(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  cleanups.push(() => ws.close());
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
    ws.on("close", (code) => reject(new Error(`closed ${code}`)));
  });
  return ws;
}

describe("ws-bridge server", () => {
  it("proxies bytes to an allowlisted target and back", async () => {
    const echo = await startEcho();
    cleanups.push(echo.close);
    const bridge = startBridge({ port: 0, allowlist: new Set([`127.0.0.1:${echo.port}`]), allowPrivate: true });
    cleanups.push(bridge.close);
    const port = await bridge.ready;

    const ws = await connectWs(`ws://127.0.0.1:${port}/?target=127.0.0.1:${echo.port}`);
    const got = new Promise<Buffer>((r) => ws.on("message", (d) => r(d as Buffer)));
    ws.send(Buffer.from([1, 2, 3, 4]));
    expect(Array.from(await got)).toEqual([1, 2, 3, 4]);
  });

  it("refuses a non-allowlisted target (close 1008)", async () => {
    const bridge = startBridge({ port: 0, allowlist: new Set(["64.23.162.51:9735"]), allowPrivate: true });
    cleanups.push(bridge.close);
    const port = await bridge.ready;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/?target=1.2.3.4:9999`);
    cleanups.push(() => ws.close());
    const code = await new Promise<number>((r) => ws.on("close", (c) => r(c)));
    expect(code).toBe(1008);
  });

  it("refuses a private target when allowPrivate is off", async () => {
    const echo = await startEcho();
    cleanups.push(echo.close);
    const bridge = startBridge({ port: 0, allowlist: new Set([`127.0.0.1:${echo.port}`]) /* allowPrivate off */ });
    cleanups.push(bridge.close);
    const port = await bridge.ready;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/?target=127.0.0.1:${echo.port}`);
    cleanups.push(() => ws.close());
    const code = await new Promise<number>((r) => ws.on("close", (c) => r(c)));
    expect(code).toBe(1008);
  });

  it("falls back to BRIDGE_TARGET when no ?target is given", async () => {
    const echo = await startEcho();
    cleanups.push(echo.close);
    const bridge = startBridge({
      port: 0,
      allowlist: new Set([`127.0.0.1:${echo.port}`]),
      fallbackTarget: `127.0.0.1:${echo.port}`,
      allowPrivate: true,
    });
    cleanups.push(bridge.close);
    const port = await bridge.ready;

    const ws = await connectWs(`ws://127.0.0.1:${port}/`);
    const got = new Promise<Buffer>((r) => ws.on("message", (d) => r(d as Buffer)));
    ws.send(Buffer.from([9, 9]));
    expect(Array.from(await got)).toEqual([9, 9]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @libre/ws-bridge exec vitest run src/server.test.ts`
Expected: FAIL — cannot resolve `./server`.

- [ ] **Step 3: Write the server**

Create `ws-bridge/src/server.ts`:

```ts
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import net from "node:net";
import { isTargetAllowed, parseTarget } from "./allowlist";

export interface BridgeConfig {
  port: number;
  allowlist: Set<string>;
  fallbackTarget?: string; // used when the client sends no ?target (back-compat with old single-target)
  allowPrivate?: boolean; // test-only: permit loopback targets
  maxConnsPerIp?: number; // default 8
  log?: (m: string) => void;
}

export function startBridge(cfg: BridgeConfig): { ready: Promise<number>; close: () => Promise<void> } {
  const log = cfg.log ?? ((m: string) => console.log(`[ws-bridge] ${m}`));
  const maxPerIp = cfg.maxConnsPerIp ?? 8;
  const perIp = new Map<string, number>();
  const wss = new WebSocketServer({ port: cfg.port });

  const ready = new Promise<number>((resolve) =>
    wss.on("listening", () => resolve((wss.address() as net.AddressInfo).port))
  );

  wss.on("connection", (ws: WebSocket, req) => {
    const ip = req.socket.remoteAddress ?? "?";
    const url = new URL(req.url ?? "/", "http://localhost");
    const rawTarget = url.searchParams.get("target") ?? cfg.fallbackTarget ?? "";

    if (!isTargetAllowed(rawTarget, cfg.allowlist, { allowPrivate: cfg.allowPrivate })) {
      log(`reject ${ip} target=${rawTarget || "(none)"}: not allowed`);
      ws.close(1008, "target not allowed");
      return;
    }

    const cur = perIp.get(ip) ?? 0;
    if (cur >= maxPerIp) {
      log(`reject ${ip}: too many connections`);
      ws.close(1013, "too many connections");
      return;
    }
    perIp.set(ip, cur + 1);
    const release = () => {
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
    };

    const { host, port } = parseTarget(rawTarget)!;
    log(`open ${ip} -> ${host}:${port}`);
    const tcp = net.connect(port, host);

    tcp.on("data", (d) => {
      if (ws.readyState === ws.OPEN) ws.send(d);
    });
    tcp.on("close", () => ws.close());
    tcp.on("error", (e) => {
      log(`tcp error ${host}:${port}: ${e.message}`);
      ws.close(1011, "upstream error");
    });

    ws.on("message", (d: RawData) => {
      tcp.write(d as Buffer);
    });
    ws.on("close", () => {
      tcp.destroy();
      release();
    });
    ws.on("error", () => {
      tcp.destroy();
    });
  });

  return {
    ready,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @libre/ws-bridge exec vitest run src/server.test.ts`
Expected: PASS (4 tests: proxy, reject-non-allowlisted, reject-private, fallback).

- [ ] **Step 5: Write the entry point**

Create `ws-bridge/src/main.ts`:

```ts
import { startBridge } from "./server";

const port = Number(process.env.PORT ?? 8080);
const fallbackTarget = (process.env.BRIDGE_TARGET ?? "").trim() || undefined;
const allowlist = new Set(
  (process.env.BRIDGE_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .concat(fallbackTarget ? [fallbackTarget] : [])
);
const allowPrivate = process.env.BRIDGE_ALLOW_PRIVATE === "1";
const maxConnsPerIp = Number(process.env.MAX_CONNS_PER_IP ?? 8);

const bridge = startBridge({ port, allowlist, fallbackTarget, allowPrivate, maxConnsPerIp });
void bridge.ready.then((p) =>
  console.log(`[ws-bridge] listening :${p} allowlist={${[...allowlist].join(",")}} fallback=${fallbackTarget ?? "(none)"}`)
);
```

- [ ] **Step 6: Typecheck + build the bridge**

Run: `pnpm --filter @libre/ws-bridge build`
Expected: `tsc` succeeds, emits `ws-bridge/dist/{allowlist,server,main}.js`.

- [ ] **Step 7: Commit** (pause for approval)

```bash
git add ws-bridge/src/server.ts ws-bridge/src/server.test.ts ws-bridge/src/main.ts
git commit -m "feat(ws-bridge): ws<->tcp proxy with allowlist gate, per-IP cap, and BRIDGE_TARGET fallback"
```

---

### Task 4: bridge Dockerfile + README (deploy)

**Files:**
- Modify: `ws-bridge/Dockerfile`
- Modify: `ws-bridge/README.md`

**Interfaces:** none (deploy artifacts).

- [ ] **Step 1: Rewrite the Dockerfile for Node**

Replace `ws-bridge/Dockerfile` with:

```dockerfile
# Multi-target TCP<->WebSocket bridge so a browser LDK node can reach an allowlisted set of
# Lightning peers (the default channel peer + the LSPs). Browsers can't open raw TCP; this proxies
# a (wss, via Railway TLS) WebSocket to the requested peer's TCP :9735, gated by BRIDGE_ALLOWLIST.
FROM node:20-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-package-lock
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-package-lock
COPY --from=build /app/dist ./dist
# Railway injects PORT and terminates TLS (public endpoint is wss://). Override these in Railway:
ENV BRIDGE_TARGET=45.33.65.45:9735
ENV BRIDGE_ALLOWLIST=64.23.162.51:9735,45.79.192.236:9735,45.33.65.45:9735
CMD ["node", "dist/main.js"]
```

- [ ] **Step 2: Update the README**

Replace `ws-bridge/README.md` body to document: the multi-target model, the `?target=host:port` chain, `BRIDGE_ALLOWLIST` (Megalith `64.23.162.51:9735`, Olympus `45.79.192.236:9735`, default peer `45.33.65.45:9735`), the `BRIDGE_TARGET` fallback, that the app URL (`VITE_MAINNET_BRIDGE` / `DEFAULT_MAINNET_BRIDGE`) is unchanged, and that a custom peer means running your own bridge. Key deploy block:

````markdown
## Deploy (Railway, its own service)

```bash
railway up -s ws-bridge
```

Set in Railway → service → Variables:

```
BRIDGE_ALLOWLIST=64.23.162.51:9735,45.79.192.236:9735,45.33.65.45:9735
BRIDGE_TARGET=45.33.65.45:9735
```

Megalith = `64.23.162.51:9735`, Olympus (ZEUS) = `45.79.192.236:9735`, default peer = `45.33.65.45:9735`.
The LSP IPs come from each LSP's live `lsps1 get_info` `uris` — update the allowlist if they change.
The public endpoint (`wss://<svc>.up.railway.app`) and the app's `VITE_MAINNET_BRIDGE` are unchanged.
````

- [ ] **Step 3: Commit** (pause for approval)

```bash
git add ws-bridge/Dockerfile ws-bridge/README.md
git commit -m "chore(ws-bridge): Node Dockerfile + multi-target/allowlist deploy docs"
```

---

### Task 5: extension transport appends the target

**Files:**
- Modify: `packages/browser-extension/src/core/ws-provider.ts`
- Test: `packages/browser-extension/src/core/ws-provider.test.ts` (create)

**Interfaces:**
- Consumes: `bridgeTargetUrl` (Task 1).

- [ ] **Step 1: Write the failing test**

Create `packages/browser-extension/src/core/ws-provider.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { createWebSocketStreamProvider } from "./ws-provider";

class FakeWS {
  static last?: string;
  static OPEN = 1;
  readyState = 1;
  binaryType = "";
  onopen?: () => void;
  onerror?: () => void;
  onmessage?: (e: { data: ArrayBuffer }) => void;
  onclose?: () => void;
  constructor(url: string) {
    FakeWS.last = url;
    queueMicrotask(() => this.onopen?.());
  }
  send() {}
  close() {}
}

const realWS = (globalThis as any).WebSocket;
afterEach(() => {
  (globalThis as any).WebSocket = realWS;
});

describe("createWebSocketStreamProvider", () => {
  it("dials the bridge with ?target=host:port", async () => {
    (globalThis as any).WebSocket = FakeWS;
    const provider = createWebSocketStreamProvider(() => "wss://bridge.example");
    await provider.connect("64.23.162.51", 9735);
    expect(FakeWS.last).toBe("wss://bridge.example?target=64.23.162.51%3A9735");
  });

  it("rejects when no bridge URL is configured", async () => {
    (globalThis as any).WebSocket = FakeWS;
    const provider = createWebSocketStreamProvider(() => undefined);
    await expect(provider.connect("1.2.3.4", 9735)).rejects.toThrow(/bridge/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @libre/browser-extension exec vitest run src/core/ws-provider.test.ts`
Expected: FAIL — `FakeWS.last` is the bare base `wss://bridge.example` (no `?target=`), so the first assertion fails.

- [ ] **Step 3: Update the provider**

In `packages/browser-extension/src/core/ws-provider.ts`, add the import at the top:

```ts
import { bridgeTargetUrl } from "@libre/shared";
```

Change the connect body so the socket dials the target-appended URL:

```ts
    connect(address: string, port: number): Promise<WebSocketConnection> {
      const base = getBridgeUrl();
      if (!base) {
        return Promise.reject(new Error("No bridge URL configured — cannot connect to Lightning peer."));
      }
      const wsUrl = bridgeTargetUrl(base, address, port);
      const socket = new WebSocket(wsUrl);
```

(Leave the rest of the function unchanged — `wsUrl` is already referenced in the error message and handlers.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @libre/browser-extension exec vitest run src/core/ws-provider.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck the extension**

Run: `pnpm --filter @libre/browser-extension typecheck`
Expected: no errors.

- [ ] **Step 6: Commit** (pause for approval)

```bash
git add packages/browser-extension/src/core/ws-provider.ts packages/browser-extension/src/core/ws-provider.test.ts
git commit -m "feat(extension): transport appends ?target=host:port so the bridge can reach the LSP"
```

---

### Task 6: PWA transports append the target (main.ts + service-worker.ts)

**Files:**
- Modify: `packages/example-app/src/main.ts` (`BrowserWebSocketStreamProvider.connect`, ~line 29)
- Modify: `packages/example-app/src/service-worker.ts` (~line 58)

**Interfaces:**
- Consumes: `bridgeTargetUrl` (Task 1).

> These two files have no existing unit tests (main.ts boots the whole app; the SW is bundled by tsup). Coverage for the URL construction lives in Task 1's `bridgeTargetUrl` test; here the deliverable is verified by typecheck + build.

- [ ] **Step 1: Update `main.ts`**

`main.ts` already imports from `@libre/shared` — add `bridgeTargetUrl` to that import line:

```ts
import { LSPS1_REST_PROVIDERS, bridgeTargetUrl } from "@libre/shared";
```

In `BrowserWebSocketStreamProvider.connect(address, port)` (~line 36), the current line is:

```ts
    const socket = new WebSocket(wsUrl);
```

Replace it with (here `wsUrl` is the bridge base from the `#ws-bridge-url` input / `ws://127.0.0.1:8091`):

```ts
    const socket = new WebSocket(bridgeTargetUrl(wsUrl, address, port));
```

- [ ] **Step 2: Update `service-worker.ts`**

Add the import at the top of `packages/example-app/src/service-worker.ts`:

```ts
import { bridgeTargetUrl } from "@libre/shared";
```

Inside `socketProvider.connect(host, port)` (~line 58), the current line is:

```ts
      const socket = new WebSocket(wsUrl);
```

Replace it with (here `wsUrl` is `config.bridgeUrl`; the params are `host, port`):

```ts
      const socket = new WebSocket(bridgeTargetUrl(wsUrl, host, port));
```

Note: the SW bundles all deps via tsup with `@libre/shared` in `noExternal` already (it imports the full SDK which re-exports shared), so no bundling change is needed — Step 3's build proves the SW still evaluates.

- [ ] **Step 3: Typecheck + build the PWA (also builds the SW via tsup)**

Run: `pnpm --filter @libre/example-app exec tsc --noEmit`
Expected: no errors.
Run: `pnpm --filter @libre/example-app build`
Expected: build success (Vite + the tsup SW build both pass — proves the SW bundle still resolves `@libre/shared`).

- [ ] **Step 4: Commit** (pause for approval)

```bash
git add packages/example-app/src/main.ts packages/example-app/src/service-worker.ts
git commit -m "feat(example-app): PWA + service-worker transports append ?target=host:port"
```

---

### Task 7: Full verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Run the whole workspace test + lint + storage guard**

Run: `pnpm check:storage`
Expected: SDK + example-app + extension storage-contract suites pass (unchanged invariants).

Run: `pnpm test`
Expected: all package suites pass, including the new `@libre/ws-bridge` allowlist + server tests, the shared `bridgeTargetUrl` test, and the extension `ws-provider` test.

Run: `pnpm lint`
Expected: 0 errors (warnings are the pre-existing backlog).

- [ ] **Step 2: Manual end-to-end note (post-deploy, not a code step)**

After deploying the bridge (Task 4) with `BRIDGE_ALLOWLIST` set, exercise on mainnet from the extension/PWA: Start node → open the LSPS1 "Add a channel to receive payments" section → Get quote & order against Megalith. Success = `create_order` returns a real fee/invoice (proves the browser reached the LSP node through the bridge), no "not connected" error. Record the outcome in the `mainnet-lsp-integration` memory.
```
