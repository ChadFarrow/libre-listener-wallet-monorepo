# LSPS2 Onboarding Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A minimal regtest LSP (`@libre/lsps2-server`) that implements the LSPS2 JSON-RPC the app already speaks and, on `buy`, opens a non-anchor channel from `libre-lnd` to the listener with pushed sats — funding the wallet via the app's existing Request Invoice button.

**Architecture:** Standalone Express service (like the push gateway) at `127.0.0.1:9099/lsps2`. A pure JSON-RPC router delegates to an injected `LspBackend`; the concrete backend composes an `LndRestClient` (open channel) and `BitcoindClient` (mine to confirm). All external I/O goes through an injected `fetch` so units test against the HTTP boundary, no real lnd needed.

**Tech Stack:** TypeScript, Express, Node `fetch`, Vitest (node), tsup (CJS), pnpm + Turborepo. Reuses `@libre/shared` LSPS2 types.

## Global Constraints

- Package manager **pnpm@10.10.0**; build via Turborepo/tsup; vitest `environment: "node"`.
- No hardcoded secrets — lnd macaroon/cert + bitcoind creds come from **env/config**.
- No changes to the SDK or example-app code (config-only: app's `lsp-api-url` already defaults to `http://127.0.0.1:9099/lsps2`).
- Channel opens use `commitment_type: "STATIC_REMOTE_KEY"` (non-anchor) so lnd's commitment feerate matches LDK's (avoids the regtest anchor 2500-vs-12480 mismatch).
- Defaults: channel capacity **1_000_000 sat**, push **200_000 sat**, confirm with **3** mined blocks.
- No silent catches — errors logged + returned as JSON-RPC `error` (repo guardrail).
- TDD: red → green → refactor. Mock only the HTTP boundary (injected `fetch`), never business logic.
- Files kebab-case; types PascalCase; functions camelCase. Never commit to `master`; feature branch; no push without approval.

---

## File Structure

- `packages/libre-lsps2-server/package.json` — new package `@libre/lsps2-server`.
- `packages/libre-lsps2-server/{tsconfig.json,tsup.config.ts,vitest.config.ts}` — mirror the gateway.
- `packages/libre-lsps2-server/src/config.ts` — env → `Lsps2ServerConfig`.
- `packages/libre-lsps2-server/src/lnd-client.ts` — `LndRestClient` (getInfo, openChannel, findChannelScid).
- `packages/libre-lsps2-server/src/bitcoind-client.ts` — `BitcoindClient` (mineBlocks).
- `packages/libre-lsps2-server/src/jsonrpc.ts` — pure `handleJsonRpc(body, backend, opts)`.
- `packages/libre-lsps2-server/src/backend.ts` — `LndLspBackend` implementing `LspBackend` (composes lnd + bitcoind).
- `packages/libre-lsps2-server/src/index.ts` — `LibreLsps2Server` (Express wiring) + exports.
- `packages/libre-lsps2-server/server.cjs` — dev entry (reads config, builds clients, starts server).
- `packages/libre-lsps2-server/src/tests/*.test.ts` — unit tests.
- `packages/libre-lsps2-server/README.md` — dev setup (docker cp macaroon/cert, env, run).

---

## Task 0: Branch + package scaffold

**Files:** Create `packages/libre-lsps2-server/{package.json,tsconfig.json,tsup.config.ts,vitest.config.ts,src/index.ts}`

- [ ] **Step 1: Branch**

```bash
cd /Users/chad-mini/Vibe/libre-listener-wallet-monorepo
git checkout -b feat/lsps2-onboarding-server
```

- [ ] **Step 2: package.json**

Create `packages/libre-lsps2-server/package.json`:
```json
{
  "name": "@libre/lsps2-server",
  "version": "0.1.0",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "start": "node server.cjs",
    "test": "vitest run"
  },
  "dependencies": {
    "@libre/shared": "workspace:*",
    "cors": "^2.8.5",
    "express": "^4.19.2"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "tsup": "^8.0.2",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 3: configs (mirror gateway)**

`packages/libre-lsps2-server/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
```
`packages/libre-lsps2-server/tsup.config.ts`:
```ts
import { defineConfig } from "tsup";
export default defineConfig({ entry: ["src/index.ts"], format: ["cjs"], dts: true, clean: true, sourcemap: true, minify: false });
```
`packages/libre-lsps2-server/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", globals: true } });
```

- [ ] **Step 4: placeholder entry so build works**

`packages/libre-lsps2-server/src/index.ts`:
```ts
export const LSPS2_SERVER_VERSION = "0.1.0";
```

- [ ] **Step 5: install + build**

Run: `pnpm install && pnpm --filter @libre/lsps2-server build`
Expected: install succeeds; tsup emits `dist/index.js`.

- [ ] **Step 6: Commit**

```bash
git add packages/libre-lsps2-server pnpm-lock.yaml
git commit -m "chore(lsps2-server): scaffold @libre/lsps2-server package"
```

---

## Task 1: JSON-RPC router

**Files:** Create `packages/libre-lsps2-server/src/jsonrpc.ts`, `packages/libre-lsps2-server/src/tests/jsonrpc.test.ts`

**Interfaces:**
- Produces:
  - `interface LspBackend { lspNodeId(): Promise<string>; openAndConfirm(clientNodeId: string): Promise<{ scid: string }>; }`
  - `interface JsonRpcRequest { jsonrpc: "2.0"; id: string | number; method: string; params?: any; }`
  - `handleJsonRpc(req: JsonRpcRequest, backend: LspBackend): Promise<object>` — returns the full JSON-RPC response object.

- [ ] **Step 1: Write the failing test**

`packages/libre-lsps2-server/src/tests/jsonrpc.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { handleJsonRpc, LspBackend } from "../jsonrpc";

const lnPub = "02".padEnd(66, "a");
const client = "03".padEnd(66, "b");

function backend(over: Partial<LspBackend> = {}): LspBackend {
  return {
    lspNodeId: vi.fn(async () => lnPub),
    openAndConfirm: vi.fn(async (_c: string) => ({ scid: "111x1x1" })),
    ...over,
  };
}

describe("handleJsonRpc", () => {
  it("get_versions returns [1]", async () => {
    const r: any = await handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "lsps2.get_versions" }, backend());
    expect(r).toEqual({ jsonrpc: "2.0", id: 1, result: { versions: [1] } });
  });

  it("get_info returns a zero-fee menu + payment bounds", async () => {
    const r: any = await handleJsonRpc({ jsonrpc: "2.0", id: 2, method: "lsps2.get_info", params: { version: 1, client_node_id: client } }, backend());
    expect(r.result.min_payment_size_msat).toBe("1000");
    expect(r.result.max_payment_size_msat).toBe("100000000");
    const m = r.result.opening_fee_params_menu[0];
    expect(m.min_fee_msat).toBe("0");
    expect(m.proportional_fee_ppm).toBe(0);
    expect(m.cltv_expiry_delta).toBe(144);
  });

  it("buy opens+confirms a channel and returns the scid", async () => {
    const be = backend();
    const r: any = await handleJsonRpc(
      { jsonrpc: "2.0", id: 3, method: "lsps2.buy", params: { version: 1, client_node_id: client, opening_fee_params: { opening_fee_params_id: "dev" } } },
      be
    );
    expect(be.openAndConfirm).toHaveBeenCalledWith(client);
    expect(r.result).toMatchObject({ jit_channel_scid: "111x1x1", lsp_node_id: lnPub, client_node_id: client, cltv_expiry_delta: 144 });
  });

  it("buy with a non-66-hex client_node_id errors without touching the backend", async () => {
    const be = backend();
    const r: any = await handleJsonRpc({ jsonrpc: "2.0", id: 4, method: "lsps2.buy", params: { client_node_id: "nope" } }, be);
    expect(r.error.code).toBe(-32602);
    expect(be.openAndConfirm).not.toHaveBeenCalled();
  });

  it("unknown method → -32601", async () => {
    const r: any = await handleJsonRpc({ jsonrpc: "2.0", id: 5, method: "lsps2.frobnicate" }, backend());
    expect(r.error.code).toBe(-32601);
  });
});
```

- [ ] **Step 2: Run → fail**

Run: `pnpm --filter @libre/lsps2-server exec vitest run src/tests/jsonrpc.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/libre-lsps2-server/src/jsonrpc.ts`:
```ts
import type {
  Lsps2GetVersionsResponse,
  Lsps2GetInfoResponse,
  Lsps2BuyResponse,
} from "@libre/shared";

export interface LspBackend {
  lspNodeId(): Promise<string>;
  openAndConfirm(clientNodeId: string): Promise<{ scid: string }>;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: any;
}

const ok = (id: string | number, result: object) => ({ jsonrpc: "2.0" as const, id, result });
const err = (id: string | number, code: number, message: string) => ({ jsonrpc: "2.0" as const, id, error: { code, message } });
const isHexPubkey = (s: unknown): s is string => typeof s === "string" && /^[0-9a-fA-F]{66}$/.test(s);

export async function handleJsonRpc(req: JsonRpcRequest, backend: LspBackend): Promise<object> {
  const { id, method, params } = req;
  switch (method) {
    case "lsps2.get_versions": {
      const result: Lsps2GetVersionsResponse = { versions: [1] };
      return ok(id, result);
    }
    case "lsps2.get_info": {
      const result: Lsps2GetInfoResponse = {
        opening_fee_params_menu: [
          {
            opening_fee_params_id: "dev",
            min_fee_msat: "0",
            proportional_fee_ppm: 0,
            min_lifetime_blocks: 2016,
            cltv_expiry_delta: 144,
            valid_until: new Date(Date.now() + 3600_000).toISOString(),
          },
        ],
        min_payment_size_msat: "1000",
        max_payment_size_msat: "100000000",
      };
      return ok(id, result);
    }
    case "lsps2.buy": {
      const clientNodeId = params?.client_node_id;
      if (!isHexPubkey(clientNodeId)) return err(id, -32602, "Invalid params: client_node_id must be a 66-char hex pubkey");
      const lspNodeId = await backend.lspNodeId();
      const { scid } = await backend.openAndConfirm(clientNodeId);
      const result: Lsps2BuyResponse = {
        jit_channel_scid: scid,
        lsp_node_id: lspNodeId,
        client_node_id: clientNodeId,
        payment_size_msat: typeof params?.payment_size_msat === "string" ? params.payment_size_msat : "0",
        cltv_expiry_delta: 144,
      };
      return ok(id, result);
    }
    default:
      return err(id, -32601, "Method not found");
  }
}
```

- [ ] **Step 4: Run → pass**

Run: `pnpm --filter @libre/lsps2-server exec vitest run src/tests/jsonrpc.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/libre-lsps2-server/src/jsonrpc.ts packages/libre-lsps2-server/src/tests/jsonrpc.test.ts
git commit -m "feat(lsps2-server): LSPS2 JSON-RPC router (get_versions/get_info/buy)"
```

---

## Task 2: lnd REST client

**Files:** Create `packages/libre-lsps2-server/src/lnd-client.ts`, `packages/libre-lsps2-server/src/tests/lnd-client.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `class LndRestClient` with:
  - `constructor(cfg: { restUrl: string; macaroonHex: string; fetchImpl?: typeof fetch })`
  - `getInfo(): Promise<{ identity_pubkey: string }>`
  - `openChannel(p: { nodePubkeyHex: string; localFundingSat: number; pushSat: number }): Promise<{ fundingTxid: string; outputIndex: number }>`
  - `findChannelScid(p: { nodePubkeyHex: string; fundingTxid: string; outputIndex: number }): Promise<string>`

- [ ] **Step 1: Write the failing test**

`packages/libre-lsps2-server/src/tests/lnd-client.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { LndRestClient } from "../lnd-client";

function fakeFetch(routes: Record<string, any>) {
  return vi.fn(async (url: string, init?: any) => {
    const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
    const r = routes[key];
    if (!r) return { ok: false, status: 404, text: async () => "no route " + key } as any;
    return { ok: true, status: 200, json: async () => r, text: async () => JSON.stringify(r) } as any;
  });
}

const cfg = (fetchImpl: any) => ({ restUrl: "https://127.0.0.1:8088", macaroonHex: "deadbeef", fetchImpl });

describe("LndRestClient", () => {
  it("getInfo returns identity_pubkey", async () => {
    const f = fakeFetch({ "GET /v1/getinfo": { identity_pubkey: "02abc" } });
    const c = new LndRestClient(cfg(f));
    expect((await c.getInfo()).identity_pubkey).toBe("02abc");
    expect(f.mock.calls[0][1].headers["Grpc-Metadata-macaroon"]).toBe("deadbeef");
  });

  it("openChannel POSTs the right non-anchor body and returns the funding point", async () => {
    const f = fakeFetch({ "POST /v1/channels": { funding_txid_str: "aa", output_index: 1 } });
    const c = new LndRestClient(cfg(f));
    const out = await c.openChannel({ nodePubkeyHex: "03def", localFundingSat: 1000000, pushSat: 200000 });
    expect(out).toEqual({ fundingTxid: "aa", outputIndex: 1 });
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body.node_pubkey_string).toBe("03def");
    expect(body.local_funding_amount).toBe("1000000");
    expect(body.push_sat).toBe("200000");
    expect(body.private).toBe(true);
    expect(body.commitment_type).toBe("STATIC_REMOTE_KEY");
  });

  it("findChannelScid returns chan_id for the matching channel_point", async () => {
    const f = fakeFetch({ "GET /v1/channels": { channels: [
      { remote_pubkey: "03def", channel_point: "aa:1", chan_id: "12345" },
      { remote_pubkey: "0399", channel_point: "bb:0", chan_id: "999" },
    ] } });
    const c = new LndRestClient(cfg(f));
    expect(await c.findChannelScid({ nodePubkeyHex: "03def", fundingTxid: "aa", outputIndex: 1 })).toBe("12345");
  });

  it("throws with lnd error text on non-2xx", async () => {
    const f = vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" }) as any);
    const c = new LndRestClient(cfg(f));
    await expect(c.getInfo()).rejects.toThrow(/lnd REST 500: boom/);
  });
});
```

- [ ] **Step 2: Run → fail**

Run: `pnpm --filter @libre/lsps2-server exec vitest run src/tests/lnd-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/libre-lsps2-server/src/lnd-client.ts`:
```ts
export interface LndRestConfig {
  restUrl: string;
  macaroonHex: string;
  fetchImpl?: typeof fetch;
}

export class LndRestClient {
  private restUrl: string;
  private macaroonHex: string;
  private fetchImpl: typeof fetch;

  constructor(cfg: LndRestConfig) {
    this.restUrl = cfg.restUrl.replace(/\/$/, "");
    this.macaroonHex = cfg.macaroonHex;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async call(method: string, path: string, body?: object): Promise<any> {
    const res = await this.fetchImpl(`${this.restUrl}${path}`, {
      method,
      headers: { "Grpc-Metadata-macaroon": this.macaroonHex, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`lnd REST ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async getInfo(): Promise<{ identity_pubkey: string }> {
    return this.call("GET", "/v1/getinfo");
  }

  // OpenChannelSync — returns the funding point synchronously.
  async openChannel(p: { nodePubkeyHex: string; localFundingSat: number; pushSat: number }): Promise<{ fundingTxid: string; outputIndex: number }> {
    const r = await this.call("POST", "/v1/channels", {
      node_pubkey_string: p.nodePubkeyHex,
      local_funding_amount: String(p.localFundingSat),
      push_sat: String(p.pushSat),
      private: true,
      commitment_type: "STATIC_REMOTE_KEY",
    });
    return { fundingTxid: r.funding_txid_str, outputIndex: r.output_index ?? 0 };
  }

  async findChannelScid(p: { nodePubkeyHex: string; fundingTxid: string; outputIndex: number }): Promise<string> {
    const r = await this.call("GET", "/v1/channels");
    const point = `${p.fundingTxid}:${p.outputIndex}`;
    const chan = (r.channels ?? []).find(
      (c: any) => c.remote_pubkey === p.nodePubkeyHex && c.channel_point === point
    );
    if (!chan) throw new Error(`channel ${point} not found in listchannels`);
    return String(chan.chan_id);
  }
}
```

- [ ] **Step 4: Run → pass**

Run: `pnpm --filter @libre/lsps2-server exec vitest run src/tests/lnd-client.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/libre-lsps2-server/src/lnd-client.ts packages/libre-lsps2-server/src/tests/lnd-client.test.ts
git commit -m "feat(lsps2-server): lnd REST client (getInfo/openChannel/findChannelScid)"
```

---

## Task 3: bitcoind RPC client (mine to confirm)

**Files:** Create `packages/libre-lsps2-server/src/bitcoind-client.ts`, `packages/libre-lsps2-server/src/tests/bitcoind-client.test.ts`

**Interfaces:**
- Produces: `class BitcoindClient` with `constructor(cfg: { rpcUrl: string; user: string; pass: string; fetchImpl?: typeof fetch })` and `mineBlocks(n: number): Promise<void>` (calls `getnewaddress` then `generatetoaddress`).

- [ ] **Step 1: Write the failing test**

`packages/libre-lsps2-server/src/tests/bitcoind-client.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { BitcoindClient } from "../bitcoind-client";

describe("BitcoindClient", () => {
  it("mineBlocks gets an address then generates N blocks", async () => {
    const calls: any[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push(body.method);
      const result = body.method === "getnewaddress" ? "bcrt1qaddr" : ["hash1", "hash2", "hash3"];
      return { ok: true, status: 200, json: async () => ({ result, error: null }), text: async () => "" } as any;
    });
    const c = new BitcoindClient({ rpcUrl: "http://127.0.0.1:18443", user: "libre", pass: "listener", fetchImpl });
    await c.mineBlocks(3);
    expect(calls).toEqual(["getnewaddress", "generatetoaddress"]);
    const genBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(genBody.params).toEqual([3, "bcrt1qaddr"]);
  });

  it("throws on bitcoind error", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: null, error: { message: "bad" } }) }) as any);
    const c = new BitcoindClient({ rpcUrl: "http://x", user: "u", pass: "p", fetchImpl });
    await expect(c.mineBlocks(1)).rejects.toThrow(/bitcoind: bad/);
  });
});
```

- [ ] **Step 2: Run → fail**

Run: `pnpm --filter @libre/lsps2-server exec vitest run src/tests/bitcoind-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/libre-lsps2-server/src/bitcoind-client.ts`:
```ts
export interface BitcoindConfig {
  rpcUrl: string;
  user: string;
  pass: string;
  fetchImpl?: typeof fetch;
}

export class BitcoindClient {
  private cfg: BitcoindConfig;
  private fetchImpl: typeof fetch;
  constructor(cfg: BitcoindConfig) {
    this.cfg = cfg;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async rpc(method: string, params: any[]): Promise<any> {
    const auth = Buffer.from(`${this.cfg.user}:${this.cfg.pass}`).toString("base64");
    const res = await this.fetchImpl(this.cfg.rpcUrl, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "1.0", id: "lsps2", method, params }),
    });
    if (!res.ok) throw new Error(`bitcoind HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (data.error) throw new Error(`bitcoind: ${data.error.message ?? JSON.stringify(data.error)}`);
    return data.result;
  }

  async mineBlocks(n: number): Promise<void> {
    const addr = await this.rpc("getnewaddress", []);
    await this.rpc("generatetoaddress", [n, addr]);
  }
}
```

- [ ] **Step 4: Run → pass**

Run: `pnpm --filter @libre/lsps2-server exec vitest run src/tests/bitcoind-client.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/libre-lsps2-server/src/bitcoind-client.ts packages/libre-lsps2-server/src/tests/bitcoind-client.test.ts
git commit -m "feat(lsps2-server): bitcoind RPC client (mineBlocks)"
```

---

## Task 4: Backend + Express server + dev entry

**Files:** Create `packages/libre-lsps2-server/src/backend.ts`, `packages/libre-lsps2-server/src/config.ts`, `packages/libre-lsps2-server/server.cjs`; Modify `packages/libre-lsps2-server/src/index.ts`; Test `packages/libre-lsps2-server/src/tests/backend.test.ts`

**Interfaces:**
- Consumes: `LspBackend`, `handleJsonRpc` (Task 1); `LndRestClient` (Task 2); `BitcoindClient` (Task 3).
- Produces:
  - `class LndLspBackend implements LspBackend` — `constructor({ lnd, bitcoind, capacitySat, pushSat, confirmBlocks })`.
  - `class LibreLsps2Server` — `constructor({ backend, logger? })`, `start(port): Promise<void>`, `stop(): Promise<void>` (Express, `POST /lsps2`).
  - `loadConfig(env): Lsps2ServerConfig`.

- [ ] **Step 1: Write the failing test (backend wiring)**

`packages/libre-lsps2-server/src/tests/backend.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { LndLspBackend } from "../backend";

describe("LndLspBackend.openAndConfirm", () => {
  it("opens a channel, mines, and returns the scid", async () => {
    const lnd = {
      getInfo: vi.fn(async () => ({ identity_pubkey: "02lsp" })),
      openChannel: vi.fn(async () => ({ fundingTxid: "aa", outputIndex: 1 })),
      findChannelScid: vi.fn(async () => "678"),
    } as any;
    const bitcoind = { mineBlocks: vi.fn(async () => {}) } as any;
    const be = new LndLspBackend({ lnd, bitcoind, capacitySat: 1000000, pushSat: 200000, confirmBlocks: 3 });

    expect(await be.lspNodeId()).toBe("02lsp");
    const out = await be.openAndConfirm("03client".padEnd(66, "b"));
    expect(lnd.openChannel).toHaveBeenCalledWith({ nodePubkeyHex: "03client".padEnd(66, "b"), localFundingSat: 1000000, pushSat: 200000 });
    expect(bitcoind.mineBlocks).toHaveBeenCalledWith(3);
    expect(out).toEqual({ scid: "678" });
  });
});
```

- [ ] **Step 2: Run → fail**

Run: `pnpm --filter @libre/lsps2-server exec vitest run src/tests/backend.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement backend + config + server + entry**

`packages/libre-lsps2-server/src/backend.ts`:
```ts
import type { LspBackend } from "./jsonrpc";
import type { LndRestClient } from "./lnd-client";
import type { BitcoindClient } from "./bitcoind-client";

export class LndLspBackend implements LspBackend {
  constructor(
    private deps: { lnd: LndRestClient; bitcoind: BitcoindClient; capacitySat: number; pushSat: number; confirmBlocks: number }
  ) {}

  async lspNodeId(): Promise<string> {
    return (await this.deps.lnd.getInfo()).identity_pubkey;
  }

  async openAndConfirm(clientNodeId: string): Promise<{ scid: string }> {
    const { lnd, bitcoind, capacitySat, pushSat, confirmBlocks } = this.deps;
    const fp = await lnd.openChannel({ nodePubkeyHex: clientNodeId, localFundingSat: capacitySat, pushSat });
    await bitcoind.mineBlocks(confirmBlocks);
    const scid = await lnd.findChannelScid({ nodePubkeyHex: clientNodeId, fundingTxid: fp.fundingTxid, outputIndex: fp.outputIndex });
    return { scid };
  }
}
```

`packages/libre-lsps2-server/src/config.ts`:
```ts
import * as fs from "fs";

export interface Lsps2ServerConfig {
  port: number;
  lndRestUrl: string;
  lndMacaroonHex: string;
  bitcoindRpcUrl: string;
  bitcoindUser: string;
  bitcoindPass: string;
  capacitySat: number;
  pushSat: number;
  confirmBlocks: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Lsps2ServerConfig {
  // Macaroon: hex directly, or read+hex-encode a file path.
  let macaroonHex = env.LND_MACAROON_HEX ?? "";
  if (!macaroonHex && env.LND_MACAROON_PATH) {
    macaroonHex = fs.readFileSync(env.LND_MACAROON_PATH).toString("hex");
  }
  return {
    port: Number(env.PORT ?? 9099),
    lndRestUrl: env.LND_REST_URL ?? "https://127.0.0.1:8088",
    lndMacaroonHex: macaroonHex,
    bitcoindRpcUrl: env.BITCOIND_RPC_URL ?? "http://127.0.0.1:18443",
    bitcoindUser: env.BITCOIND_RPC_USER ?? "libre",
    bitcoindPass: env.BITCOIND_RPC_PASS ?? "listener",
    capacitySat: Number(env.CHANNEL_CAPACITY_SAT ?? 1_000_000),
    pushSat: Number(env.PUSH_SAT ?? 200_000),
    confirmBlocks: Number(env.CONFIRM_BLOCKS ?? 3),
  };
}
```

`packages/libre-lsps2-server/src/index.ts` (replace placeholder):
```ts
import express from "express";
import cors from "cors";
import type { Server } from "http";
import { handleJsonRpc, LspBackend, JsonRpcRequest } from "./jsonrpc";

export * from "./jsonrpc";
export * from "./lnd-client";
export * from "./bitcoind-client";
export * from "./backend";
export * from "./config";

export interface Logger { info(m: string): void; error(m: string): void; }

export class LibreLsps2Server {
  private app = express();
  private server?: Server;
  constructor(private deps: { backend: LspBackend; logger?: Logger }) {
    this.app.use(cors());
    this.app.use(express.json());
    this.app.post("/lsps2", async (req, res) => {
      try {
        const response = await handleJsonRpc(req.body as JsonRpcRequest, this.deps.backend);
        res.json(response);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.deps.logger?.error(`lsps2 request failed: ${message}`);
        res.json({ jsonrpc: "2.0", id: (req.body as any)?.id ?? null, error: { code: -32000, message } });
      }
    });
    this.app.get("/health", (_req, res) => res.json({ ok: true }));
  }

  start(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(port, "127.0.0.1", () => {
        this.deps.logger?.info(`LSPS2 onboarding server on http://127.0.0.1:${port}/lsps2`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
```

`packages/libre-lsps2-server/server.cjs` (dev entry):
```js
// Dev entry. Regtest only: trusts lnd's self-signed TLS cert for localhost.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? "0";
const { LibreLsps2Server, LndRestClient, BitcoindClient, LndLspBackend, loadConfig } = require("./dist/index.js");

const cfg = loadConfig();
if (!cfg.lndMacaroonHex) {
  console.error("Missing LND_MACAROON_HEX or LND_MACAROON_PATH — see README.");
  process.exit(1);
}
const lnd = new LndRestClient({ restUrl: cfg.lndRestUrl, macaroonHex: cfg.lndMacaroonHex });
const bitcoind = new BitcoindClient({ rpcUrl: cfg.bitcoindRpcUrl, user: cfg.bitcoindUser, pass: cfg.bitcoindPass });
const backend = new LndLspBackend({ lnd, bitcoind, capacitySat: cfg.capacitySat, pushSat: cfg.pushSat, confirmBlocks: cfg.confirmBlocks });
const server = new LibreLsps2Server({ backend, logger: { info: (m) => console.log(m), error: (m) => console.error(m) } });
server.start(cfg.port);
```

- [ ] **Step 4: Run → pass + build**

Run: `pnpm --filter @libre/lsps2-server exec vitest run` then `pnpm --filter @libre/lsps2-server build`
Expected: all unit tests PASS; tsup build succeeds.

- [ ] **Step 5: Server smoke (no lnd needed)**

Run:
```bash
cd packages/libre-lsps2-server && node -e '
const { LibreLsps2Server } = require("./dist/index.js");
const backend = { lspNodeId: async () => "02lsp", openAndConfirm: async () => ({ scid: "1x1x1" }) };
const s = new LibreLsps2Server({ backend });
s.start(19099).then(async () => {
  const r = await fetch("http://127.0.0.1:19099/lsps2", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({jsonrpc:"2.0",id:1,method:"lsps2.get_versions"})});
  console.log("RESP", JSON.stringify(await r.json()));
  await s.stop();
});'
```
Expected: `RESP {"jsonrpc":"2.0","id":1,"result":{"versions":[1]}}`

- [ ] **Step 6: Commit**

```bash
git add packages/libre-lsps2-server/src packages/libre-lsps2-server/server.cjs
git commit -m "feat(lsps2-server): backend, Express server, dev entry"
```

---

## Task 5: README + dev setup + manual integration

**Files:** Create `packages/libre-lsps2-server/README.md`

- [ ] **Step 1: Write README with the exact dev setup**

`packages/libre-lsps2-server/README.md`:
````markdown
# `@libre/lsps2-server`

Minimal **regtest** LSP for the Libre Listener Wallet. Implements the LSPS2 JSON-RPC
the app speaks and, on `lsps2.buy`, opens a non-anchor channel from `libre-lnd` to
the listener with pushed sats — funding the wallet via the app's **Request Invoice**
button. Dev/regtest only; not production JIT.

## Setup (regtest)

1. Start the stack: `docker compose up -d` (from repo root).
2. Extract lnd's admin macaroon + TLS cert (paths discovered from the container):
   ```bash
   MAC=$(docker exec libre-lnd sh -c 'find /root /data -name admin.macaroon 2>/dev/null | head -1')
   docker exec libre-lnd cat "$MAC" | xxd -p -c 100000 > /tmp/libre-lnd-admin.macaroon.hex
   ```
3. Run the server:
   ```bash
   LND_MACAROON_HEX=$(cat /tmp/libre-lnd-admin.macaroon.hex) \
   pnpm --filter @libre/lsps2-server build && pnpm --filter @libre/lsps2-server start
   ```
   (Dev entry sets `NODE_TLS_REJECT_UNAUTHORIZED=0` for lnd's self-signed cert — localhost/regtest only.)

## Config (env)

`PORT` (9099), `LND_REST_URL` (https://127.0.0.1:8088), `LND_MACAROON_HEX` or `LND_MACAROON_PATH`,
`BITCOIND_RPC_URL` (http://127.0.0.1:18443), `BITCOIND_RPC_USER`/`PASS` (libre/listener),
`CHANNEL_CAPACITY_SAT` (1000000), `PUSH_SAT` (200000), `CONFIRM_BLOCKS` (3).

## Fund the wallet

In the app (regtest): Start node → Connect Peer → ensure **LSP API URL** = `http://127.0.0.1:9099/lsps2` → **Request Invoice**. A channel opens with ~200k spendable.
````

- [ ] **Step 2: Manual integration verification**

1. `docker compose up -d`; extract macaroon (README step 2); `pnpm --filter @libre/lsps2-server build && LND_MACAROON_HEX=... pnpm --filter @libre/lsps2-server start`.
2. `curl -s -X POST http://127.0.0.1:9099/lsps2 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"lsps2.get_info","params":{"version":1,"client_node_id":"03...66hex"}}'` → returns the fee menu.
3. In the app (regtest, node started, peer connected), click **Request Invoice** → confirm a channel + ~200k balance appear; then send a keysend boost and create+pay an invoice from `libre-lnd` to verify both directions.

- [ ] **Step 3: Commit**

```bash
git add packages/libre-lsps2-server/README.md
git commit -m "docs(lsps2-server): dev setup + funding instructions"
```

---

## Task 6: Full suite

- [ ] **Step 1: Run everything**

Run: `pnpm test`
Expected: all packages PASS (new `@libre/lsps2-server` unit tests included once it has a `test` script).

- [ ] **Step 2: Confirm with the human, then merge only on approval** (via `superpowers:finishing-a-development-branch`).

---

## Notes for the implementer
- Node 18+ provides global `fetch`; tests inject a fake `fetch`, so no network in unit tests.
- The `jit_channel_scid` is the real confirmed channel's `chan_id` (uint64 string). Funding happens via `push_sat`, so the invoice route hint is cosmetic for this dev version — if the SDK later needs a `BxTxO`-format SCID, convert in `findChannelScid`.
- Keep everything regtest-scoped; mainnet/JIT-interception is a separate milestone.
