# LSPS2 JIT Milestone 1 — LSPS0 Custom-Message Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the browser LDK node an LSPS0 custom-message transport (BOLT8 peer-message type 37913) and an `lsps2.get_versions`/`get_info` client, then use it to prove Megalith/Olympus support LSPS2 (Gate 1 — free, no sats).

**Architecture:** A pure wire-format module (`lsps-message.ts`) encodes/decodes the JSON-RPC-over-37913 payload. A correlation layer (`lsps-peer-client.ts`) implements LDK's `CustomMessageHandler`/`CustomMessageReader` from JS (queues outbound requests, resolves pending promises on matching JSON-RPC `id`). `index.ts` swaps LDK's `IgnoringMessageHandler` for ours and adds a `getLSPS2Info(...)` SDK method. A manual/opt-in live-gate script exercises it against the two mainnet LSPs through the deployed `ws-bridge`.

**Tech Stack:** TypeScript, `lightningdevkit@0.1.0` WASM bindings, vitest (jsdom + a node-env real-LDK test), `@libre/shared` types.

## Global Constraints

- Package manager pnpm (`pnpm@10.10.0`); Turborepo. Files kebab-case; functions/vars camelCase; types PascalCase.
- **TDD mandatory** (red→green→refactor). **Do NOT mock LDK internals** — the handler test drives the real LDK `CustomMessageHandler`/`Type` via `initializeWasmFromBinary`.
- **Never commit without human approval** (repo rule): commit steps are real, but pause for approval before each `git commit`.
- SDK stays platform-agnostic: no `window`/`fetch`/`process.env` in these modules; `Logger` is injected as `{ info?, warn?, error? }`. Barrel-export new public API from `index.ts`; import protocol types from `@libre/shared`.
- Async-safety lint rules are errors (`no-floating-promises`, `no-misused-promises`) — mark fire-and-forget with `void`.
- Wire format: `Type.write()` returns ONLY the JSON body (UTF-8, no length/type prefix — LDK prepends the 2-byte type from `Type.type_id()`). Message type is exactly **37913**.
- LSPS JSON-RPC `id` MUST be a string (bLIP-50). Never log message bodies in later milestones (may carry secrets); metadata only.
- `@libre/shared` resolves from its built `dist/` — it's already built; no changes to it in M1.

---

### Task 1: `lsps-message.ts` — pure LSPS0 wire format

**Files:**
- Create: `packages/libre-listener-wallet/src/lsps-message.ts`
- Test: `packages/libre-listener-wallet/src/tests/unit/lsps-message.test.ts`

**Interfaces:**
- Produces:
  - `LSPS_PEER_MSG_TYPE = 37913`
  - `encodeLspsMessage(obj: unknown): Uint8Array`
  - `decodeLspsMessage(bytes: Uint8Array): any`
  - `buildRequest(method: string, params: unknown, id: string): { jsonrpc: "2.0"; id: string; method: string; params: unknown }`
  - `parseResponse(obj: any): { id: string; result?: any; error?: { code: number; message: string; data?: unknown } } | null`
  - `newRequestId(): string`
  - `hexToBytes(hex: string): Uint8Array`

- [ ] **Step 1: Write the failing test**

Create `packages/libre-listener-wallet/src/tests/unit/lsps-message.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  LSPS_PEER_MSG_TYPE,
  encodeLspsMessage,
  decodeLspsMessage,
  buildRequest,
  parseResponse,
  newRequestId,
  hexToBytes,
} from "../../lsps-message";

describe("lsps-message wire format", () => {
  it("uses peer message type 37913", () => {
    expect(LSPS_PEER_MSG_TYPE).toBe(37913);
  });

  it("encode/decode round-trips a JSON-RPC object (UTF-8, no prefix)", () => {
    const obj = { jsonrpc: "2.0", id: "a1", method: "lsps2.get_info", params: { version: 1 } };
    const bytes = encodeLspsMessage(obj);
    // exact bytes are the JSON string in UTF-8, nothing prepended
    expect(new TextDecoder().decode(bytes)).toBe(JSON.stringify(obj));
    expect(decodeLspsMessage(bytes)).toEqual(obj);
  });

  it("buildRequest produces a JSON-RPC 2.0 request with a string id", () => {
    expect(buildRequest("lsps2.get_versions", {}, "xyz")).toEqual({
      jsonrpc: "2.0",
      id: "xyz",
      method: "lsps2.get_versions",
      params: {},
    });
  });

  it("parseResponse extracts result, error, and rejects id-less objects", () => {
    expect(parseResponse({ jsonrpc: "2.0", id: "1", result: { versions: [1] } })).toEqual({
      id: "1",
      result: { versions: [1] },
    });
    expect(parseResponse({ jsonrpc: "2.0", id: "2", error: { code: -32000, message: "no" } })).toEqual({
      id: "2",
      error: { code: -32000, message: "no" },
    });
    expect(parseResponse({ jsonrpc: "2.0", method: "notify" })).toBeNull(); // no id
    expect(parseResponse(null)).toBeNull();
  });

  it("newRequestId is unique and 32 hex chars", () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it("hexToBytes parses a pubkey and rejects malformed hex", () => {
    expect(Array.from(hexToBytes("02aa"))).toEqual([0x02, 0xaa]);
    expect(hexToBytes("0x02aa")).toEqual(new Uint8Array([0x02, 0xaa]));
    expect(() => hexToBytes("abc")).toThrow(); // odd length
    expect(() => hexToBytes("zz")).toThrow(); // not hex
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/lsps-message.test.ts`
Expected: FAIL — cannot resolve `../../lsps-message`.

- [ ] **Step 3: Write the implementation**

Create `packages/libre-listener-wallet/src/lsps-message.ts`:

```ts
// LSPS0 / bLIP-50 wire format for LSPS messages carried as a BOLT8 peer custom message (type 37913).
// The message body is a JSON-RPC 2.0 object encoded as UTF-8. LDK's PeerManager frames the message
// and prepends the 2-byte type from Type.type_id(); Type.write() returns ONLY this body — no
// length/type prefix.

export const LSPS_PEER_MSG_TYPE = 37913;

export interface JsonRpcRequestObj {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: unknown;
}

export interface JsonRpcResponseObj {
  id: string;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeLspsMessage(obj: unknown): Uint8Array {
  return enc.encode(JSON.stringify(obj));
}

export function decodeLspsMessage(bytes: Uint8Array): any {
  return JSON.parse(dec.decode(bytes));
}

export function buildRequest(method: string, params: unknown, id: string): JsonRpcRequestObj {
  return { jsonrpc: "2.0", id, method, params };
}

// Normalize a decoded JSON-RPC response to { id, result?, error? }. Returns null when the object has
// no string id (e.g. a notification) — the caller ignores those.
export function parseResponse(obj: any): JsonRpcResponseObj | null {
  if (!obj || typeof obj.id !== "string") return null;
  const out: JsonRpcResponseObj = { id: obj.id };
  if ("result" in obj) out.result = obj.result;
  if (obj.error) out.error = obj.error;
  return out;
}

export function newRequestId(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("hex string must have even length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid hex");
    out[i] = byte;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/lsps-message.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit** (pause for approval)

```bash
git add packages/libre-listener-wallet/src/lsps-message.ts packages/libre-listener-wallet/src/tests/unit/lsps-message.test.ts
git commit -m "feat(sdk): LSPS0 wire format (peer-msg 37913 JSON-RPC encode/decode)"
```

---

### Task 2: `lsps-peer-client.ts` — correlation layer + LDK trait impls

**Files:**
- Create: `packages/libre-listener-wallet/src/lsps-peer-client.ts`
- Test: `packages/libre-listener-wallet/src/tests/unit/lsps-peer-client.test.ts`

**Interfaces:**
- Consumes (Task 1): `LSPS_PEER_MSG_TYPE`, `encodeLspsMessage`, `decodeLspsMessage`, `buildRequest`, `parseResponse`, `newRequestId`, `hexToBytes`.
- Produces:
  - `class LspsPeerClient` with:
    - `constructor(cfg?: { logger?: { info?; warn?; error? } })`
    - `buildHandler(): CustomMessageHandler` — the LDK handler backed by this client
    - `setPeerManager(pm: PeerManager): void`
    - `request(peerPubkeyHex: string, method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<any>`
    - `getVersions(peerPubkeyHex: string): Promise<Lsps2GetVersionsResponse>`
    - `getInfo(peerPubkeyHex: string, params: { version: number; token?: string }): Promise<Lsps2GetInfoResponse>`

**LDK binding facts (verified against `lightningdevkit@0.1.0`):**
- `CustomMessageHandler.new_impl(handlerIface, readerIface)`. `handlerIface` MUST implement: `handle_custom_message(msg: Type, sender: Uint8Array): Result_NoneLightningErrorZ`, `get_and_clear_pending_msg(): TwoTuple_PublicKeyTypeZ[]`, `peer_disconnected(id: Uint8Array): void`, `peer_connected(id: Uint8Array, msg: Init, inbound: boolean): Result_NoneNoneZ`, `provided_node_features(): NodeFeatures`, `provided_init_features(id: Uint8Array): InitFeatures`.
- `readerIface`: `read(messageType: number, buffer: Uint8Array): Result_COption_TypeZDecodeErrorZ`.
- Constructors: `Result_NoneLightningErrorZ.constructor_ok()`, `Result_NoneNoneZ.constructor_ok()`, `Result_COption_TypeZDecodeErrorZ.constructor_ok(Option_TypeZ)`, `Option_TypeZ.constructor_some(Type)` / `.constructor_none()`, `NodeFeatures.constructor_empty()`, `InitFeatures.constructor_empty()`, `TwoTuple_PublicKeyTypeZ.constructor_new(pubkey: Uint8Array, t: Type)`, `Type.new_impl({ type_id, debug_str, write })`. Tuple accessors: `.get_a(): Uint8Array`, `.get_b(): Type`. `Type`: `.type_id(): number`, `.write(): Uint8Array`.

- [ ] **Step 1: Write the failing test**

Create `packages/libre-listener-wallet/src/tests/unit/lsps-peer-client.test.ts`:

```ts
// @vitest-environment node
// Drives the REAL LDK CustomMessageHandler (no mocking) — proves our request queues a 37913 message
// with the right bytes, and an incoming response resolves the correct pending promise.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { Type, initializeWasmFromBinary } from "lightningdevkit";
import * as fs from "fs";
import * as path from "path";
import { LspsPeerClient } from "../../lsps-peer-client";
import { encodeLspsMessage, decodeLspsMessage, LSPS_PEER_MSG_TYPE } from "../../lsps-message";

function loadWasmBinary(): Uint8Array {
  const paths = [
    path.resolve(__dirname, "../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "../../node_modules/lightningdevkit/liblightningjs.wasm"),
  ];
  for (const p of paths) if (fs.existsSync(p)) return fs.readFileSync(p);
  throw new Error("Could not find liblightningjs.wasm");
}

beforeAll(async () => {
  try {
    await initializeWasmFromBinary(loadWasmBinary());
  } catch {
    /* already initialized */
  }
});

const PEER = "038a9e56512ec98da2b5789761f7af8f280baf98a09282360cd6ff1381b5e889bf";
const SENDER = new Uint8Array(33).fill(2);

describe("LspsPeerClient", () => {
  it("request queues an outbound 37913 message and resolves on the matching response", async () => {
    const client = new LspsPeerClient();
    const handler = client.buildHandler();
    client.setPeerManager({ process_events: () => {} } as any); // stub: flush is a no-op in the unit

    const p = client.request(PEER, "lsps2.get_versions", {});

    // Our request should now be a pending outbound message.
    const pending = handler.get_and_clear_pending_msg();
    expect(pending.length).toBe(1);
    const t = pending[0].get_b();
    expect(t.type_id()).toBe(LSPS_PEER_MSG_TYPE);
    const sentReq = decodeLspsMessage(t.write());
    expect(sentReq).toMatchObject({ jsonrpc: "2.0", method: "lsps2.get_versions", params: {} });
    expect(typeof sentReq.id).toBe("string");

    // Craft the LSP's response with the same id and feed it back through the handler.
    const respBytes = encodeLspsMessage({ jsonrpc: "2.0", id: sentReq.id, result: { versions: [1] } });
    const respType = Type.new_impl({ type_id: () => LSPS_PEER_MSG_TYPE, debug_str: () => "x", write: () => respBytes });
    handler.handle_custom_message(respType, SENDER);

    await expect(p).resolves.toEqual({ versions: [1] });
  });

  it("rejects the promise when the LSP returns a JSON-RPC error", async () => {
    const client = new LspsPeerClient();
    const handler = client.buildHandler();
    client.setPeerManager({ process_events: () => {} } as any);

    const p = client.getInfo(PEER, { version: 1 });
    const sentReq = decodeLspsMessage(handler.get_and_clear_pending_msg()[0].get_b().write());
    const respBytes = encodeLspsMessage({ jsonrpc: "2.0", id: sentReq.id, error: { code: 1, message: "unsupported" } });
    handler.handle_custom_message(
      Type.new_impl({ type_id: () => LSPS_PEER_MSG_TYPE, debug_str: () => "x", write: () => respBytes }),
      SENDER
    );
    await expect(p).rejects.toThrow(/unsupported/);
  });

  it("ignores a response with an unknown id (no throw, promise stays pending)", async () => {
    vi.useFakeTimers(); // so the request's pending timer isn't a real leaked handle
    try {
      const client = new LspsPeerClient();
      const handler = client.buildHandler();
      client.setPeerManager({ process_events: () => {} } as any);

      let settled = false;
      const p = client.request(PEER, "lsps2.get_versions", {}, { timeoutMs: 60_000 });
      void p.then(() => (settled = true)).catch(() => (settled = true));
      handler.get_and_clear_pending_msg(); // drain

      const stray = encodeLspsMessage({ jsonrpc: "2.0", id: "not-a-real-id", result: {} });
      expect(() =>
        handler.handle_custom_message(
          Type.new_impl({ type_id: () => LSPS_PEER_MSG_TYPE, debug_str: () => "x", write: () => stray }),
          SENDER
        )
      ).not.toThrow();
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers(); // discards the still-pending fake timer
    }
  });

  it("rejects on timeout", async () => {
    vi.useFakeTimers();
    try {
      const client = new LspsPeerClient();
      client.buildHandler();
      client.setPeerManager({ process_events: () => {} } as any);
      const p = client.request(PEER, "lsps2.get_versions", {}, { timeoutMs: 5000 });
      const rejected = expect(p).rejects.toThrow(/timed out/);
      vi.advanceTimersByTime(5001);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/lsps-peer-client.test.ts`
Expected: FAIL — cannot resolve `../../lsps-peer-client`.

- [ ] **Step 3: Write the implementation**

Create `packages/libre-listener-wallet/src/lsps-peer-client.ts`:

```ts
// LSPS0 request/response client over LDK custom peer messages (type 37913). Implements LDK's
// CustomMessageHandler/CustomMessageReader from JS: outbound LSPS requests are queued and flushed by
// PeerManager.process_events(); incoming responses are correlated to pending promises by JSON-RPC id.
import {
  CustomMessageHandler,
  CustomMessageReader,
  Type,
  TwoTuple_PublicKeyTypeZ,
  Option_TypeZ,
  NodeFeatures,
  InitFeatures,
  Result_NoneLightningErrorZ,
  Result_NoneNoneZ,
  Result_COption_TypeZDecodeErrorZ,
  type PeerManager,
  type Init,
} from "lightningdevkit";
import type { Lsps2GetVersionsResponse, Lsps2GetInfoResponse } from "@libre/shared";
import {
  LSPS_PEER_MSG_TYPE,
  encodeLspsMessage,
  decodeLspsMessage,
  buildRequest,
  parseResponse,
  newRequestId,
  hexToBytes,
  type JsonRpcResponseObj,
} from "./lsps-message";

export interface LspsPeerClientConfig {
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LspsPeerClient {
  private outbound: Array<{ peer: Uint8Array; obj: unknown }> = [];
  private pending = new Map<string, Pending>();
  private pm?: PeerManager;
  private logger?: LspsPeerClientConfig["logger"];

  constructor(cfg: LspsPeerClientConfig = {}) {
    this.logger = cfg.logger;
  }

  setPeerManager(pm: PeerManager): void {
    this.pm = pm;
  }

  // Build the LDK CustomMessageHandler backed by this client's queue + pending map.
  buildHandler(): CustomMessageHandler {
    const reader = CustomMessageReader.new_impl({
      read: (messageType: number, buffer: Uint8Array): Result_COption_TypeZDecodeErrorZ => {
        if (messageType !== LSPS_PEER_MSG_TYPE) {
          return Result_COption_TypeZDecodeErrorZ.constructor_ok(Option_TypeZ.constructor_none());
        }
        const t = Type.new_impl({
          type_id: () => LSPS_PEER_MSG_TYPE,
          debug_str: () => "lsps",
          write: () => buffer,
        });
        return Result_COption_TypeZDecodeErrorZ.constructor_ok(Option_TypeZ.constructor_some(t));
      },
    });

    return CustomMessageHandler.new_impl(
      {
        handle_custom_message: (msg: Type, _sender: Uint8Array): Result_NoneLightningErrorZ => {
          try {
            const resp = parseResponse(decodeLspsMessage(msg.write()));
            if (resp) this.deliver(resp);
          } catch (e) {
            this.logger?.warn?.(`[LSPS] undecodable custom message: ${(e as Error).message}`);
          }
          return Result_NoneLightningErrorZ.constructor_ok();
        },
        get_and_clear_pending_msg: (): TwoTuple_PublicKeyTypeZ[] => {
          const drained = this.outbound.splice(0);
          return drained.map(({ peer, obj }) =>
            TwoTuple_PublicKeyTypeZ.constructor_new(
              peer,
              Type.new_impl({
                type_id: () => LSPS_PEER_MSG_TYPE,
                debug_str: () => "lsps",
                write: () => encodeLspsMessage(obj),
              })
            )
          );
        },
        peer_disconnected: (_id: Uint8Array): void => {},
        peer_connected: (_id: Uint8Array, _msg: Init, _inbound: boolean): Result_NoneNoneZ =>
          Result_NoneNoneZ.constructor_ok(),
        provided_node_features: (): NodeFeatures => NodeFeatures.constructor_empty(),
        provided_init_features: (_id: Uint8Array): InitFeatures => InitFeatures.constructor_empty(),
      },
      reader
    );
  }

  private deliver(resp: JsonRpcResponseObj): void {
    const p = this.pending.get(resp.id);
    if (!p) return; // unknown or already-expired id — ignore
    this.pending.delete(resp.id);
    clearTimeout(p.timer);
    if (resp.error) p.reject(new Error(`LSPS error ${resp.error.code}: ${resp.error.message}`));
    else p.resolve(resp.result);
  }

  request(peerPubkeyHex: string, method: string, params: unknown, opts: { timeoutMs?: number } = {}): Promise<any> {
    const id = newRequestId();
    const timeoutMs = opts.timeoutMs ?? 15000;
    const peer = hexToBytes(peerPubkeyHex);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSPS request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.outbound.push({ peer, obj: buildRequest(method, params, id) });
      // Flush now; LDK also flushes on its own timer, but this sends promptly.
      this.pm?.process_events();
    });
  }

  getVersions(peerPubkeyHex: string): Promise<Lsps2GetVersionsResponse> {
    return this.request(peerPubkeyHex, "lsps2.get_versions", {});
  }

  getInfo(peerPubkeyHex: string, params: { version: number; token?: string }): Promise<Lsps2GetInfoResponse> {
    return this.request(peerPubkeyHex, "lsps2.get_info", params);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/lsps-peer-client.test.ts`
Expected: PASS (4 tests). If a binding constructor name differs at runtime, fix the import/call to the actual exported name (the d.mts signatures above are authoritative) — do not mock around it.

- [ ] **Step 5: Commit** (pause for approval)

```bash
git add packages/libre-listener-wallet/src/lsps-peer-client.ts packages/libre-listener-wallet/src/tests/unit/lsps-peer-client.test.ts
git commit -m "feat(sdk): LspsPeerClient — LDK custom-message transport + JSON-RPC correlation"
```

---

### Task 3: Wire into `index.ts` + `getLSPS2Info` SDK method

**Files:**
- Modify: `packages/libre-listener-wallet/src/index.ts` (PeerManager construction ~line 556-566; add a private `lspsPeerClient` field; add the `getLSPS2Info` method; barrel-export `LspsPeerClient`)

**Interfaces:**
- Consumes (Task 2): `LspsPeerClient`, its `buildHandler()`, `setPeerManager()`, `getVersions()`, `getInfo()`.
- Consumes (existing): `this.connectPeer(pubkey, host, port)` (dials via the ws-bridge), `this.peerManager`.
- Produces: `LibreListenerWallet.getLSPS2Info(opts: { lspPubkey: string; lspHost: string; lspPort: number }): Promise<Lsps2GetInfoResponse>`.

> This is integration wiring; it has no cheap unit test (it needs a live node + peer). Its deliverable is verified by typecheck + build + the existing SDK unit suite staying green. The behavior is proven by Task 4's live gate.

- [ ] **Step 1: Add the peer-client field and build the handler into the PeerManager**

In `packages/libre-listener-wallet/src/index.ts`:

1. Add the import near the other local imports:

```ts
import { LspsPeerClient } from "./lsps-peer-client";
```

2. Add a private field alongside `private peerManager?: PeerManager;` (~line 228):

```ts
  private lspsPeerClient?: LspsPeerClient;
```

3. Replace the PeerManager construction block (currently ~lines 557-566):

```ts
    // 11. Setup PeerManager
    const ignoringHandler = IgnoringMessageHandler.constructor_new();
    this.peerManager = PeerManager.constructor_new(
      this.channelManager.as_ChannelMessageHandler(),
      ignoringHandler.as_RoutingMessageHandler(),
      ignoringHandler.as_OnionMessageHandler(),
      ignoringHandler.as_CustomMessageHandler(),
      Math.floor(Date.now() / 1000),
      getSecureRandomBytes(32),
      this.ldkLogger,
      this.keysManager.as_NodeSigner()
```

with (only the custom-handler arg changes; keep the trailing args + closing exactly as they are):

```ts
    // 11. Setup PeerManager. Use our LSPS custom-message handler (type 37913) instead of the
    // ignoring one so the node can speak LSPS2 to an LSP over the peer connection.
    const ignoringHandler = IgnoringMessageHandler.constructor_new();
    this.lspsPeerClient = new LspsPeerClient({ logger: this.logger });
    this.peerManager = PeerManager.constructor_new(
      this.channelManager.as_ChannelMessageHandler(),
      ignoringHandler.as_RoutingMessageHandler(),
      ignoringHandler.as_OnionMessageHandler(),
      this.lspsPeerClient.buildHandler(),
      Math.floor(Date.now() / 1000),
      getSecureRandomBytes(32),
      this.ldkLogger,
      this.keysManager.as_NodeSigner()
```

4. Immediately AFTER the `PeerManager.constructor_new(...)` statement completes (after its closing `);`), give the client the PeerManager reference:

```ts
    this.lspsPeerClient.setPeerManager(this.peerManager);
```

(Read the surrounding lines first to place this right after the assignment closes and before the next block.)

- [ ] **Step 2: Add the `getLSPS2Info` method**

Add this method to the `LibreListenerWallet` class (near `requestLSPS2Invoice` / other LSP methods). Ensure `Lsps2GetInfoResponse` is imported from `@libre/shared` (add to the existing shared import if not present):

```ts
  /**
   * LSPS2 discovery over the BOLT8 peer transport (custom message 37913): connect to the LSP node
   * (dialed through the configured ws-bridge), then lsps2.get_versions -> lsps2.get_info. Returns the
   * fee-param menu. Gate-1 check that a real LSP actually speaks LSPS2. Does not spend anything.
   */
  async getLSPS2Info(opts: { lspPubkey: string; lspHost: string; lspPort: number }): Promise<Lsps2GetInfoResponse> {
    if (!this.peerManager || !this.lspsPeerClient) {
      throw new Error("Wallet is not running");
    }
    await this.connectPeer(opts.lspPubkey, opts.lspHost, opts.lspPort);
    const versions = await this.lspsPeerClient.getVersions(opts.lspPubkey);
    const version = Math.max(...(versions.versions ?? []));
    if (!Number.isFinite(version) || version <= 0) {
      throw new Error(`LSP ${opts.lspPubkey} returned no LSPS2 versions`);
    }
    this.logger?.info?.(`[LSPS2] ${opts.lspPubkey} supports versions ${JSON.stringify(versions.versions)}; using ${version}`);
    return this.lspsPeerClient.getInfo(opts.lspPubkey, { version });
  }
```

- [ ] **Step 3: Barrel-export `LspsPeerClient`**

Near the other re-exports at the bottom of `index.ts` (e.g. the `export { Lsps1RestClient, ... }` line), add:

```ts
export { LspsPeerClient } from "./lsps-peer-client";
```

- [ ] **Step 4: Typecheck + build + run the existing unit suite**

Run: `pnpm --filter @libre/listener-wallet build`
Expected: tsup ESM + CJS + DTS build success (the new code compiles).
Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit`
Expected: PASS — all existing unit tests plus `lsps-message` (6) and `lsps-peer-client` (4) green; the PeerManager change didn't break node startup tests.

- [ ] **Step 5: Commit** (pause for approval)

```bash
git add packages/libre-listener-wallet/src/index.ts
git commit -m "feat(sdk): wire LspsPeerClient into PeerManager + getLSPS2Info(lsp) method"
```

---

### Task 4: Live-gate script + runbook (Gate 1 — manual, opt-in, not CI)

**Files:**
- Create: `packages/libre-listener-wallet/scripts/lsps2-getinfo-gate.mjs`
- Create: `packages/libre-listener-wallet/scripts/README-lsps2-gate.md`

**Interfaces:**
- Consumes (Task 3): the built SDK (`dist/`) `LibreListenerWallet` + `getLSPS2Info`.

> Not a CI test — it boots a real mainnet node and connects over the live ws-bridge. It's the Gate-1 execution: run it, record whether Megalith/Olympus answer LSPS2. This task produces the tooling; running it is the go/no-go for milestone 2.

- [ ] **Step 1: Write the gate script**

Create `packages/libre-listener-wallet/scripts/lsps2-getinfo-gate.mjs`. It boots a throwaway in-memory wallet on mainnet, points the WebSocket transport at the deployed bridge (appending `?target=` like the app transports), connects to each LSP, and prints the `get_info` result:

```js
// LSPS2 Gate-1: does a real mainnet LSP answer lsps2.get_info over BOLT8 peer-msg 37913?
// Boots a throwaway in-memory node, connects to each LSP through the deployed ws-bridge, prints the
// fee menu. No sats spent. Run: node scripts/lsps2-getinfo-gate.mjs   (from the package dir, after `pnpm build`)
import { LibreListenerWallet } from "../dist/index.mjs";
import { bridgeTargetUrl } from "@libre/shared";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const BRIDGE = "wss://ws-bridge-production-9e2f.up.railway.app";
const ESPLORA = "https://mempool.space/api";
const LSPS = [
  { name: "Megalith", pubkey: "038a9e56512ec98da2b5789761f7af8f280baf98a09282360cd6ff1381b5e889bf", host: "64.23.162.51", port: 9735 },
  { name: "Olympus", pubkey: "031b301307574bbe9b9ac7b79cbe1700e31e544513eae0b5d7497483083f99e581", host: "45.79.192.236", port: 9735 },
];

// Minimal in-memory storage + a global-WebSocket transport that appends ?target= (Node 22 has global WebSocket).
const mem = new Map();
const storage = {
  getItem: async (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: async (k, v) => void mem.set(k, v),
  removeItem: async (k) => void mem.delete(k),
};
const socketProvider = {
  connect: async (address, port) => {
    const ws = new WebSocket(bridgeTargetUrl(BRIDGE, address, port));
    ws.binaryType = "arraybuffer";
    const conn = { send: (d) => ws.readyState === 1 && ws.send(d), close: () => ws.close() };
    ws.onmessage = (e) => conn.onmessage?.(new Uint8Array(e.data));
    ws.onclose = () => conn.onclose?.();
    return new Promise((res, rej) => {
      ws.onopen = () => res(conn);
      ws.onerror = () => (ws.readyState === 1 ? conn.onerror?.(new Error("ws error")) : rej(new Error("bridge connect failed")));
    });
  },
};

const wallet = new LibreListenerWallet({
  network: "mainnet",
  esploraUrl: ESPLORA,
  storage,
  socketProvider,
  logger: { info: (m) => console.log("[i]", m), warn: (m) => console.warn("[w]", m), error: (m) => console.error("[e]", m) },
});

await wallet.start();
for (const lsp of LSPS) {
  try {
    const info = await wallet.getLSPS2Info({ lspPubkey: lsp.pubkey, lspHost: lsp.host, lspPort: lsp.port });
    console.log(`\n=== ${lsp.name}: LSPS2 SUPPORTED ✓ ===`);
    console.log("  min/max payment msat:", info.min_payment_size_msat, "/", info.max_payment_size_msat);
    console.log("  fee params:", JSON.stringify(info.opening_fee_params_menu?.slice(0, 2), null, 2));
  } catch (e) {
    console.log(`\n=== ${lsp.name}: NO LSPS2 (or timeout) — ${e.message} ===`);
  }
}
await wallet.stop();
process.exit(0);
```

(If the real `LibreListenerWallet` constructor option names differ from `{ network, esploraUrl, storage, socketProvider, logger }`, read `src/index.ts`'s constructor signature and match it exactly — the script must use the real API, not invent one.)

- [ ] **Step 2: Write the runbook**

Create `packages/libre-listener-wallet/scripts/README-lsps2-gate.md` documenting: prerequisites (`pnpm --filter @libre/listener-wallet build` first; the ws-bridge must be deployed with Megalith/Olympus in `BRIDGE_ALLOWLIST` — it is), the run command (`node scripts/lsps2-getinfo-gate.mjs` from the package dir), how to read the result (a printed fee menu = **Gate 1 PASS**, both timing out = LSPS2 unsupported → pivot), and that it spends no sats.

- [ ] **Step 3: Build the SDK so the script's `../dist/index.mjs` exists**

Run: `pnpm --filter @libre/listener-wallet build`
Expected: build success; `packages/libre-listener-wallet/dist/index.mjs` present.

- [ ] **Step 4: Commit** (pause for approval)

```bash
git add packages/libre-listener-wallet/scripts/lsps2-getinfo-gate.mjs packages/libre-listener-wallet/scripts/README-lsps2-gate.md
git commit -m "chore(sdk): LSPS2 get_info Gate-1 live script + runbook (manual, no sats)"
```

- [ ] **Step 5: RUN THE GATE (go/no-go for milestone 2)**

Run: `cd packages/libre-listener-wallet && node scripts/lsps2-getinfo-gate.mjs` (allow ~60s; it syncs a mainnet header then connects).
Record the outcome:
- **PASS** — at least one LSP prints a fee-param menu → the transport works and LSPS2 is supported; proceed to design milestone 2 (buy + wrapped invoice + claim) with the real fee-param shape in hand.
- **FAIL** — both time out / error → they don't offer LSPS2 over 37913; record it in the `mainnet-lsp-integration` memory and stop M2 until an LSPS2-capable LSP is found (via the `.well-known` registry).
Note the exact `opening_fee_params_menu` shape (field names, whether `promise` is HMAC-signed, the `min_lifetime_blocks`/`proportional`/`min_fee_msat` values) — milestone 2's `buy` design depends on it.

---

## Verification (whole milestone)

- `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit` — all unit suites green incl. the two new files.
- `pnpm --filter @libre/listener-wallet build` — tsup build clean.
- `pnpm --filter @libre/listener-wallet lint` — 0 errors.
- `pnpm check:storage` — unaffected (no storage-layer change), still green.
- **Gate 1 result recorded** (Task 4 Step 5) — the milestone's real deliverable.
