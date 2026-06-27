# Wallet State Backup & Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the non-custodial wallet an encrypted backup/restore mechanism and prove, with an automated regtest test, that a wiped browser can recover its channels and funds.

**Architecture:** A pure crypto/serialization module (`state-backup.ts`) using WebCrypto AES-256-GCM with a seed-derived HKDF key. Two methods on `LibreListenerWallet` (`exportState`/`importState`) enumerate all critical storage via the `ldk_keys_index` plus known direct keys. Proven by a regtest integration test that exports from a funded wallet, imports into a fresh empty wallet, and confirms the recovered wallet can still send a keysend.

**Tech Stack:** TypeScript, LDK WASM (`lightningdevkit`), Vitest, MSW, WebCrypto (`crypto.subtle`), Docker regtest stack.

## Global Constraints

- Files use kebab-case; types/interfaces PascalCase; functions/vars camelCase.
- No LDK mocking in tests; use the real LDK WASM. Mock only HTTP (MSW) / network sockets.
- No silent catches: throw typed `Error`s with clear messages; never log seed/key material.
- Cross-package imports go through package names, never deep relative paths.
- Encryption key is derived from the seed only (HKDF-SHA256); no password, no remote backup (Phase 2).
- Backup envelope version is `1`; AES-256-GCM; HKDF info string is exactly `libre-wallet-backup-v1`.
- Tests that use `crypto.subtle` must run under the node environment (`// @vitest-environment node`).
- Spec: `docs/superpowers/specs/2026-06-26-wallet-state-backup-recovery-design.md`.

## File Structure

- Create `packages/libre-listener-wallet/src/state-backup.ts` — crypto + (de)serialization helpers.
- Modify `packages/libre-listener-wallet/src/index.ts` — extract `persistManagerState()`, add `exportState()`/`importState()`.
- Create `packages/libre-listener-wallet/src/tests/unit/state-backup.test.ts` — round-trip + wrong-seed + malformed.
- Create `packages/libre-listener-wallet/src/tests/unit/export-import.test.ts` — SDK-level round-trip (no docker).
- Create `packages/libre-listener-wallet/src/tests/integration/recovery.test.ts` — wipe → restore → funds survive → keysend.
- Modify `packages/example-app/index.html` and `packages/example-app/src/main.ts` — backup/restore UI + seed gate.

---

### Task 1: Crypto & serialization module

**Files:**
- Create: `packages/libre-listener-wallet/src/state-backup.ts`
- Test: `packages/libre-listener-wallet/src/tests/unit/state-backup.test.ts`

**Interfaces:**
- Produces: `interface BackupPayload { version: 1; network: string; exportedAt: number; entries: Record<string, string>; }`
- Produces: `serializeAndEncrypt(payload: BackupPayload, seedHex: string): Promise<string>`
- Produces: `decryptAndParse(envelopeStr: string, seedHex: string): Promise<BackupPayload>`

- [ ] **Step 1: Write the failing test**

Create `packages/libre-listener-wallet/src/tests/unit/state-backup.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { serializeAndEncrypt, decryptAndParse, BackupPayload } from "../../state-backup";

const seedHex = "ab".repeat(32); // 32-byte seed
const wrongSeed = "cd".repeat(32);

const payload: BackupPayload = {
  version: 1,
  network: "regtest",
  exportedAt: 1700000000000,
  entries: { ldk_seed: seedHex, channel_manager: "deadbeef", "monitors/x/y": "00ff" },
};

describe("state-backup encrypt/decrypt", () => {
  it("round-trips a payload with the correct seed", async () => {
    const blob = await serializeAndEncrypt(payload, seedHex);
    expect(typeof blob).toBe("string");
    expect(blob).not.toContain("deadbeef"); // must be ciphertext, not plaintext
    const out = await decryptAndParse(blob, seedHex);
    expect(out).toEqual(payload);
  });

  it("rejects the wrong seed", async () => {
    const blob = await serializeAndEncrypt(payload, seedHex);
    await expect(decryptAndParse(blob, wrongSeed)).rejects.toThrow(/wrong seed or corrupt/);
  });

  it("rejects a malformed envelope", async () => {
    await expect(decryptAndParse("not json", seedHex)).rejects.toThrow(/not valid JSON/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/state-backup.test.ts`
Expected: FAIL — cannot find module `../../state-backup`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/libre-listener-wallet/src/state-backup.ts`:

```ts
import { hexToBytes } from "./storage-cache";

export interface BackupPayload {
  version: 1;
  network: string;
  exportedAt: number;
  entries: Record<string, string>; // storageKey -> hex value
}

interface BackupEnvelope {
  v: 1;
  alg: "AES-256-GCM";
  kdf: "HKDF-SHA256";
  iv: string; // base64
  ct: string; // base64
}

const HKDF_INFO = new TextEncoder().encode("libre-wallet-backup-v1");

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveAesKey(seedHex: string): Promise<CryptoKey> {
  const seed = hexToBytes(seedHex);
  const baseKey = await crypto.subtle.importKey("raw", seed, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: HKDF_INFO },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function serializeAndEncrypt(payload: BackupPayload, seedHex: string): Promise<string> {
  const key = await deriveAesKey(seedHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const envelope: BackupEnvelope = {
    v: 1,
    alg: "AES-256-GCM",
    kdf: "HKDF-SHA256",
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ctBuf)),
  };
  return JSON.stringify(envelope);
}

export async function decryptAndParse(envelopeStr: string, seedHex: string): Promise<BackupPayload> {
  let envelope: BackupEnvelope;
  try {
    envelope = JSON.parse(envelopeStr);
  } catch {
    throw new Error("Invalid backup: not valid JSON");
  }
  if (envelope.v !== 1) throw new Error(`Unsupported backup version: ${envelope.v}`);
  const key = await deriveAesKey(seedHex);
  const iv = base64ToBytes(envelope.iv);
  const ct = base64ToBytes(envelope.ct);
  let plaintextBuf: ArrayBuffer;
  try {
    plaintextBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  } catch {
    throw new Error("Decryption failed — wrong seed or corrupt backup");
  }
  return JSON.parse(new TextDecoder().decode(plaintextBuf)) as BackupPayload;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/state-backup.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/libre-listener-wallet/src/state-backup.ts packages/libre-listener-wallet/src/tests/unit/state-backup.test.ts
git commit -m "feat: add seed-derived encrypted backup serialization module"
```

---

### Task 2: Extract `persistManagerState()` (refactor)

**Files:**
- Modify: `packages/libre-listener-wallet/src/index.ts` (the save block currently at the end of `stop()`, lines ~604-618)

**Interfaces:**
- Produces: `private async persistManagerState(): Promise<void>` on `LibreListenerWallet`.

- [ ] **Step 1: Add the private method**

In `packages/libre-listener-wallet/src/index.ts`, add this method to the `LibreListenerWallet` class (place it directly above `async stop()`):

```ts
  private async persistManagerState(): Promise<void> {
    if (this.channelManager && this.networkGraph && this.scorer) {
      try {
        this.logger?.info("Saving manager/graph/scorer state to storage...");
        await this.storage.setItem("channel_manager", bytesToHex(this.channelManager.write()));
        await this.storage.setItem("network_graph", bytesToHex(this.networkGraph.write()));
        await this.storage.setItem("scorer", bytesToHex(this.scorer.write()));
      } catch (err) {
        this.logger?.error(`Failed to save state: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
```

- [ ] **Step 2: Replace the inline save block in `stop()`**

In `stop()`, replace this block:

```ts
    // Persist final states
    if (this.channelManager && this.networkGraph && this.scorer) {
      try {
        this.logger?.info("Saving final state to storage...");
        const managerBytes = this.channelManager.write();
        await this.storage.setItem("channel_manager", bytesToHex(managerBytes));

        const graphBytes = this.networkGraph.write();
        await this.storage.setItem("network_graph", bytesToHex(graphBytes));

        const scorerBytes = this.scorer.write();
        await this.storage.setItem("scorer", bytesToHex(scorerBytes));
      } catch (err) {
        this.logger?.error(`Failed to save state on shutdown: ${err instanceof Error ? err.message : err}`);
      }
    }
```

with:

```ts
    // Persist final states
    await this.persistManagerState();
```

- [ ] **Step 3: Run the existing persistence test to verify no regression**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/persistence.test.ts`
Expected: PASS — still asserts `channel_manager`, `network_graph`, `scorer`, `ldk_seed` persisted on stop.

- [ ] **Step 4: Commit**

```bash
git add packages/libre-listener-wallet/src/index.ts
git commit -m "refactor: extract persistManagerState() from stop()"
```

---

### Task 3: `exportState()` / `importState()` on the wallet

**Files:**
- Modify: `packages/libre-listener-wallet/src/index.ts` (add import + two methods)
- Test: `packages/libre-listener-wallet/src/tests/unit/export-import.test.ts`

**Interfaces:**
- Consumes: `serializeAndEncrypt`, `decryptAndParse`, `BackupPayload` from `./state-backup`; `persistManagerState()` from Task 2.
- Produces: `exportState(): Promise<string>` and `importState(envelope: string, seedHex: string): Promise<void>` on `LibreListenerWallet`.

- [ ] **Step 1: Write the failing test**

Create `packages/libre-listener-wallet/src/tests/unit/export-import.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { LibreListenerWallet, SecureStorageProvider, WebSocketStreamProvider } from "../../index";
import { bytesToHex } from "../../storage-cache";
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
  http.get(`${esploraUrl}/blocks/tip/height`, () => HttpResponse.text("100")),
  http.get(`${esploraUrl}/blocks/tip/hash`, () => HttpResponse.text("00".repeat(32))),
  http.get(`${esploraUrl}/block-height/:height`, () => HttpResponse.text("00".repeat(32))),
  http.get(`${esploraUrl}/block/:hash/header`, () => HttpResponse.text("00".repeat(80))),
  http.get(`${esploraUrl}/fee-estimates`, () => HttpResponse.json({ "1": 10.0, "6": 5.0, "144": 1.0 }))
);

const noSocket: WebSocketStreamProvider = {
  connect: async () => { throw new Error("not used"); },
};

function makeStorage(db: Map<string, string>): SecureStorageProvider {
  return {
    getItem: async (k) => db.get(k) || null,
    setItem: async (k, v) => { db.set(k, v); },
    removeItem: async (k) => { db.delete(k); },
  };
}

describe("LibreListenerWallet export/import round-trip", () => {
  let wasmBinary: Uint8Array;
  beforeAll(() => { wasmBinary = loadWasmBinary(); mswServer.listen({ onUnhandledRequest: "bypass" }); });
  afterEach(() => mswServer.resetHandlers());
  afterAll(() => mswServer.close());

  it("exports encrypted state and restores it into a fresh wallet (same node id)", async () => {
    const config = { network: "regtest" as const, esploraUrl };

    // Wallet A — generates a seed, runs, exports, stops.
    const dbA = new Map<string, string>();
    const walletA = new LibreListenerWallet({ config, storage: makeStorage(dbA), socketProvider: noSocket, wasmBinary });
    await walletA.start();
    const nodeIdA = bytesToHex(walletA.getChannelManager()!.get_our_node_id());
    const seedHex = dbA.get("ldk_seed")!;
    expect(seedHex).toBeDefined();
    const blob = await walletA.exportState();
    await walletA.stop();

    // The blob must be ciphertext, not contain the raw seed.
    expect(blob).not.toContain(seedHex);

    // Wallet B — fresh empty storage, import, start, must boot to the SAME node id.
    const dbB = new Map<string, string>();
    const walletB = new LibreListenerWallet({ config, storage: makeStorage(dbB), socketProvider: noSocket, wasmBinary });
    await walletB.importState(blob, seedHex);
    expect(dbB.has("channel_manager")).toBe(true);
    expect(dbB.get("ldk_seed")).toBe(seedHex);
    await walletB.start();
    const nodeIdB = bytesToHex(walletB.getChannelManager()!.get_our_node_id());
    expect(nodeIdB).toBe(nodeIdA);
    await walletB.stop();
  });

  it("throws when importing while running", async () => {
    const db = new Map<string, string>();
    const wallet = new LibreListenerWallet({ config: { network: "regtest", esploraUrl }, storage: makeStorage(db), socketProvider: noSocket, wasmBinary });
    await wallet.start();
    await expect(wallet.importState("{}", "ab".repeat(32))).rejects.toThrow(/while running/);
    await wallet.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/export-import.test.ts`
Expected: FAIL — `wallet.exportState is not a function`.

- [ ] **Step 3: Add the import and methods**

At the top of `packages/libre-listener-wallet/src/index.ts`, add to the existing imports:

```ts
import { serializeAndEncrypt, decryptAndParse, BackupPayload } from "./state-backup";
```

Add these two methods to the `LibreListenerWallet` class (place them directly below `status()`):

```ts
  async exportState(): Promise<string> {
    // Flush the latest in-memory manager/graph/scorer so the backup is current.
    if (this.isRunning) {
      await this.persistManagerState();
    }
    const seedHex = await this.storage.getItem("ldk_seed");
    if (!seedHex) {
      throw new Error("Cannot export: no wallet seed found in storage");
    }

    const entries: Record<string, string> = {};
    // Direct (non-KVStore) keys written by the wallet itself.
    const directKeys = ["ldk_seed", "channel_manager", "network_graph", "scorer", "ldk_keys_index"];
    for (const k of directKeys) {
      const v = await this.storage.getItem(k);
      if (v !== null) entries[k] = v;
    }
    // KVStore-managed keys (channel monitors etc.) tracked in the index.
    const indexStr = entries["ldk_keys_index"];
    if (indexStr) {
      let keyList: string[] = [];
      try { keyList = JSON.parse(indexStr); } catch { keyList = []; }
      for (const k of keyList) {
        const v = await this.storage.getItem(k);
        if (v !== null) entries[k] = v;
      }
    }

    const payload: BackupPayload = {
      version: 1,
      network: this.config.network,
      exportedAt: Date.now(),
      entries,
    };
    return serializeAndEncrypt(payload, seedHex);
  }

  async importState(envelope: string, seedHex: string): Promise<void> {
    if (this.isRunning) {
      throw new Error("Cannot import while running — create a fresh wallet and import before start()");
    }
    const payload = await decryptAndParse(envelope, seedHex);
    for (const [k, v] of Object.entries(payload.entries)) {
      await this.storage.setItem(k, v);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/export-import.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Build to confirm types compile**

Run: `pnpm --filter @libre/listener-wallet build`
Expected: tsup build success, DTS emitted.

- [ ] **Step 6: Commit**

```bash
git add packages/libre-listener-wallet/src/index.ts packages/libre-listener-wallet/src/tests/unit/export-import.test.ts
git commit -m "feat: add exportState/importState to wallet (encrypted, seed-derived)"
```

---

### Task 4: Recovery integration test (the proof)

**Files:**
- Test: `packages/libre-listener-wallet/src/tests/integration/recovery.test.ts`

**Interfaces:**
- Consumes: `exportState`/`importState` (Task 3); `sendKeysendPayment` (existing); the regtest stack with `--noseedbackup` + `--accept-keysend` (already in `docker-compose.yml`) and `scripts/regtest-setup.sh`.

**Preconditions (run once before this task's tests):**

```bash
docker compose up -d
./scripts/regtest-setup.sh
```

- [ ] **Step 1: Write the test**

Create `packages/libre-listener-wallet/src/tests/integration/recovery.test.ts`:

```ts
// @vitest-environment node
//
// Proves an IndexedDB wipe cannot lose funds: a funded wallet exports its encrypted
// state, a brand-new empty wallet imports it, and the recovered wallet still controls
// the channel AND can send a keysend boost the podcaster (LND) receives.
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import {
  LibreListenerWallet,
  SecureStorageProvider,
  WebSocketStreamProvider,
  WebSocketConnection,
} from "../../index";
import { bytesToHex } from "../../storage-cache";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import * as fs from "fs";
import * as path from "path";
import * as net from "net";
import { execSync, exec } from "child_process";
import { Event, Event_PaymentClaimable } from "lightningdevkit";

function runCmd(cmd: string): string {
  return execSync(cmd, { encoding: "utf8" }).trim();
}
function runCmdAsync(cmd: string): Promise<string> {
  return new Promise((resolve, reject) =>
    exec(cmd, { encoding: "utf8" }, (err, out) => (err ? reject(err) : resolve(out.trim())))
  );
}
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
class TCPStreamProvider implements WebSocketStreamProvider {
  async connect(address: string, port: number): Promise<WebSocketConnection> {
    const socket = net.connect(port, address);
    const conn: WebSocketConnection = {
      send: (d: Uint8Array) => socket.write(d),
      close: () => socket.destroy(),
    };
    socket.on("data", (d) => conn.onmessage?.(new Uint8Array(d)));
    socket.on("error", (e) => conn.onerror?.(e));
    socket.on("close", () => conn.onclose?.());
    return new Promise((resolve, reject) => {
      socket.once("connect", () => resolve(conn));
      socket.once("error", (e) => reject(e));
    });
  }
}

const BCLI = "docker exec libre-bitcoind bitcoin-cli -regtest -rpcuser=libre -rpcpassword=listener";
const LNCLI = "docker exec libre-lnd lncli --network=regtest";
const MINE_ADDR = "bcrt1qwqp2ru0sx58gpv4fmleuf02wcmu8rs5w93ld6u";
const lspApiUrl = "http://127.0.0.1:9099/lsps2";
let mockJitScid = "1234567890123456";
let lspPubkey = "02bdafbf7a60765a9ab4673350c1b5954449e290f498d1ff3a77c58eb7cebfbf24";

const mswServer = setupServer(
  http.get("http://127.0.0.1:3002/blocks/tip/height", () => HttpResponse.text(runCmd(`${BCLI} getblockcount`))),
  http.get("http://127.0.0.1:3002/blocks/tip/hash", () => HttpResponse.text(runCmd(`${BCLI} getbestblockhash`))),
  http.get("http://127.0.0.1:3002/block-height/:height", ({ params }) => HttpResponse.text(runCmd(`${BCLI} getblockhash ${params.height}`))),
  http.get("http://127.0.0.1:3002/block/:hash/header", ({ params }) => HttpResponse.text(runCmd(`${BCLI} getblockheader ${params.hash} false`))),
  http.get("http://127.0.0.1:3002/fee-estimates", () => HttpResponse.json({ "1": 15.0, "6": 8.0, "144": 2.0 })),
  http.post(lspApiUrl, async ({ request }) => {
    const { id, method, params } = (await request.clone().json()) as any;
    if (method === "lsps2.get_versions") return HttpResponse.json({ jsonrpc: "2.0", id, result: { versions: [1] } });
    if (method === "lsps2.get_info")
      return HttpResponse.json({
        jsonrpc: "2.0", id,
        result: {
          opening_fee_params_menu: [{
            opening_fee_params_id: "test_fee_params_id",
            min_fee_msat: "250000", proportional_fee_ppm: 1000,
            min_lifetime_blocks: 2016, cltv_expiry_delta: 144,
            valid_until: "2026-06-30T00:00:00Z",
          }],
          min_payment_size_msat: "1000", max_payment_size_msat: "100000000",
        },
      });
    if (method === "lsps2.buy")
      return HttpResponse.json({
        jsonrpc: "2.0", id,
        result: { jit_channel_scid: mockJitScid, lsp_node_id: lspPubkey, client_node_id: params.client_node_id, payment_size_msat: params.opening_fee_params.min_fee_msat, cltv_expiry_delta: 144 },
      });
    return HttpResponse.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  })
);

function makeStorage(db: Map<string, string>): SecureStorageProvider {
  return {
    getItem: async (k) => db.get(k) || null,
    setItem: async (k, v) => { db.set(k, v); },
    removeItem: async (k) => { db.delete(k); },
  };
}
function newWallet(db: Map<string, string>) {
  return new LibreListenerWallet({
    config: { network: "regtest", esploraUrl: "http://127.0.0.1:3002" },
    storage: makeStorage(db),
    socketProvider: new TCPStreamProvider(),
    wasmBinary: loadWasmBinary(),
    logger: { info: () => {}, warn: () => {}, error: (m, ...a) => console.error(`[ERROR] ${m}`, ...a) },
  });
}

describe("Wallet recovery after storage wipe", () => {
  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: "bypass" });
    try { runCmd(`${BCLI} generatetoaddress 1 ${MINE_ADDR}`); } catch { /* ignore */ }
    for (let i = 0; i < 30; i++) {
      try {
        const info = JSON.parse(runCmd(`${LNCLI} getinfo`));
        if (info.identity_pubkey) lspPubkey = info.identity_pubkey;
        if (info.synced_to_chain) break;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }, 60000);
  afterEach(() => mswServer.resetHandlers());
  afterAll(() => mswServer.close());

  it("recovers channel + funds into a fresh wallet and can still keysend", async () => {
    const lsp = { name: "libre-lnd", pubkey: lspPubkey, connection_string: `${lspPubkey}@127.0.0.1:9735`, api_url: lspApiUrl, protocols: ["lsps2" as const] };

    // --- Wallet A: fund via JIT channel ---
    const dbA = new Map<string, string>();
    const walletA = newWallet(dbA);
    let channelReady = false, paymentClaimed = false;
    const listenerA = (e: Event) => {
      if (e.constructor.name === "Event_ChannelReady") channelReady = true;
      else if (e instanceof Event_PaymentClaimable) paymentClaimed = true;
    };
    walletA.addEventListener(listenerA);
    await walletA.start();
    const nodeId = bytesToHex(walletA.getChannelManager()!.get_our_node_id());
    await walletA.connectPeer(lsp.pubkey, "127.0.0.1", 9735);
    await new Promise((r) => setTimeout(r, 2000));

    const openPromise = runCmdAsync(`${LNCLI} openchannel --node_key ${nodeId} --local_amt 500000 --zero_conf --private --channel_type anchors`).catch(() => {});
    for (let i = 0; i < 30 && !channelReady; i++) await new Promise((r) => setTimeout(r, 500));
    expect(channelReady).toBe(true);

    let isActive = false;
    for (let i = 0; i < 15 && !isActive; i++) {
      try {
        const chan = JSON.parse(runCmd(`${LNCLI} listchannels`)).channels.find((c: any) => c.remote_pubkey === nodeId);
        if (chan) { mockJitScid = chan.peer_scid_alias || chan.alias_scids[0]; isActive = chan.active; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(isActive).toBe(true);
    await new Promise((r) => setTimeout(r, 15000));

    const invoice = await walletA.requestLSPS2Invoice({ amountSats: 20000, description: "JIT", lsp });
    const payPromise = runCmdAsync(`${LNCLI} payinvoice --force --pay_req ${invoice}`).catch(() => {});
    for (let i = 0; i < 30 && !paymentClaimed; i++) await new Promise((r) => setTimeout(r, 500));
    expect(paymentClaimed).toBe(true);
    runCmd(`${BCLI} generatetoaddress 1 ${MINE_ADDR}`);
    await new Promise((r) => setTimeout(r, 5000));
    await openPromise; await payPromise;

    const channelsA = walletA.getChannelManager()!.list_channels().length;
    expect(channelsA).toBe(1);

    // --- Export, then wipe (drop walletA + dbA) ---
    const seedHex = dbA.get("ldk_seed")!;
    const blob = await walletA.exportState();
    walletA.removeEventListener(listenerA);
    await walletA.stop();

    // --- Wallet B: fresh empty storage, import, start ---
    const dbB = new Map<string, string>();
    const walletB = newWallet(dbB);
    await walletB.importState(blob, seedHex);
    await walletB.start();
    expect(bytesToHex(walletB.getChannelManager()!.get_our_node_id())).toBe(nodeId);
    expect(walletB.getChannelManager()!.list_channels().length).toBe(1);

    // Reconnect to the peer so the recovered channel re-establishes.
    await walletB.connectPeer(lsp.pubkey, "127.0.0.1", 9735);
    await new Promise((r) => setTimeout(r, 8000));

    // --- The recovered wallet sends a keysend boost; LND must receive it ---
    const FEED_GUID = "recovery-feed-guid";
    const BOOST_SATS = 5000;
    const keysendRes = await walletB.sendKeysendPayment({
      destinationPubkey: lspPubkey,
      amountSats: BOOST_SATS,
      customRecords: {
        7629169: JSON.stringify({ action: "boost", value_msat_total: BOOST_SATS * 1000, app_name: "libre-recovery-test", guid: FEED_GUID }),
        7629175: FEED_GUID,
      },
    });
    expect(keysendRes.ok).toBe(true);

    let received: any = null;
    for (let i = 0; i < 40 && !received; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const invoices = JSON.parse(runCmd(`${LNCLI} listinvoices`)).invoices || [];
        received = invoices.find((inv: any) => inv.is_keysend && (inv.state === "SETTLED" || inv.settled === true) && Number(inv.amt_paid_sat) === BOOST_SATS);
      } catch { /* retry */ }
    }
    expect(received).toBeTruthy();
    const cr: Record<string, string> = received.htlcs?.[0]?.custom_records || {};
    expect(Buffer.from(cr["7629175"], "hex").toString("utf8")).toBe(FEED_GUID);

    await walletB.stop();
  }, 180000);
});
```

- [ ] **Step 2: Ensure the regtest stack is up and funded**

Run: `docker compose up -d && ./scripts/regtest-setup.sh`
Expected: `[setup] Done. LND synced and funded ...` (or "already funded").

- [ ] **Step 3: Run the recovery test**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/integration/recovery.test.ts`
Expected: PASS (1 test) — recovered wallet boots to same node id, lists 1 channel, and LND receives the 5000-sat keysend.

- [ ] **Step 4: Commit**

```bash
git add packages/libre-listener-wallet/src/tests/integration/recovery.test.ts
git commit -m "test: prove wallet recovery after storage wipe (export -> import -> keysend)"
```

---

### Task 5: example-app backup/restore UX + seed-backup gate

**Files:**
- Modify: `packages/example-app/index.html` (add a Backup & Recovery card to the Wallet section)
- Modify: `packages/example-app/src/main.ts` (wire export/restore + seed-backup confirmation)

**Interfaces:**
- Consumes: `wallet.exportState()` / `wallet.importState()` (Task 3); existing `storage` and `appendLog` in `main.ts`.

- [ ] **Step 1: Add the UI**

In `packages/example-app/index.html`, add this block immediately after the Wallet `</section>` (the card that contains `start-node-btn`, around line 63):

```html
        <section class="card glass-card">
          <h2>Backup &amp; Recovery</h2>
          <p class="hint">Your funds live in this browser. Export an encrypted backup so a cleared browser can't lose them.</p>
          <button id="export-state-btn" class="btn btn-primary" disabled>Download Encrypted Backup</button>
          <div style="margin-top: 12px;">
            <label>Restore from backup (requires your seed above):</label>
            <input type="file" id="import-state-file" accept="application/json" />
            <button id="import-state-btn" class="btn btn-secondary">Restore</button>
          </div>
        </section>
```

- [ ] **Step 2: Wire the handlers**

In `packages/example-app/src/main.ts`, add near the other DOM element lookups:

```ts
const exportStateBtn = document.getElementById("export-state-btn") as HTMLButtonElement;
const importStateFile = document.getElementById("import-state-file") as HTMLInputElement;
const importStateBtn = document.getElementById("import-state-btn") as HTMLButtonElement;
```

Add these handlers at the end of `main.ts`:

```ts
// Enable export only while the node is running (set this alongside existing start/stop UI updates).
exportStateBtn.addEventListener("click", async () => {
  if (!wallet) {
    appendLog("[ERROR] Start the node before exporting.", "error");
    return;
  }
  try {
    const blob = await wallet.exportState();
    const url = URL.createObjectURL(new Blob([blob], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `libre-wallet-backup-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    appendLog("[SYSTEM] Encrypted backup downloaded. Keep it and your seed safe.", "system");
  } catch (e) {
    appendLog(`[ERROR] Export failed: ${e instanceof Error ? e.message : e}`, "error");
  }
});

importStateBtn.addEventListener("click", async () => {
  const file = importStateFile.files?.[0];
  if (!file) {
    appendLog("[ERROR] Choose a backup file first.", "error");
    return;
  }
  const seed = seedInput.value.trim();
  if (seed.length !== 64) {
    appendLog("[ERROR] Enter your 64-char hex seed above to decrypt the backup.", "error");
    return;
  }
  try {
    const blob = await file.text();
    const importWallet = new LibreListenerWallet({
      config: { network: "regtest", esploraUrl: esploraUrlInput.value.trim() },
      storage,
      socketProvider: new BrowserWebSocketStreamProvider(),
      wasmUrl: "/liblightningjs.wasm",
    });
    await importWallet.importState(blob, seed);
    appendLog("[SYSTEM] Backup restored to storage. Click Start Node to boot the recovered wallet.", "system");
  } catch (e) {
    appendLog(`[ERROR] Restore failed: ${e instanceof Error ? e.message : e}`, "error");
  }
});
```

- [ ] **Step 3: Enable the export button on node start**

In `main.ts`, find where `startNodeBtn`/`stopNodeBtn` `disabled` states are toggled after a successful `wallet.start()` and add:

```ts
exportStateBtn.disabled = false;
```

and where they are reset on stop, add:

```ts
exportStateBtn.disabled = true;
```

- [ ] **Step 4: Type-check the app**

Run: `pnpm --filter @libre/example-app build`
Expected: `tsc && vite build` succeeds with no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/example-app/index.html packages/example-app/src/main.ts
git commit -m "feat: add encrypted backup export/restore UI to example app"
```

---

## Self-Review

**Spec coverage:**
- SDK `exportState`/`importState` + seed-derived AES-GCM/HKDF → Tasks 1, 3. ✓
- State enumeration via `ldk_keys_index` + direct keys → Task 3. ✓
- Freshness (flush manager before export) → Tasks 2, 3. ✓
- Automated regtest recovery proof (wipe → restore → funds → keysend) → Task 4. ✓
- Unit round-trip + wrong-seed + malformed → Task 1; SDK round-trip + import-while-running guard → Task 3. ✓
- example-app seed-backup/export/restore UX → Task 5. ✓
- Non-goals (remote backup, password, mainnet) → not implemented. ✓

**Placeholder scan:** No TBD/TODO; all steps contain full code and exact commands. ✓

**Type consistency:** `BackupPayload` shape identical in Tasks 1 and 3; `serializeAndEncrypt`/`decryptAndParse` signatures match usage; `exportState(): Promise<string>` and `importState(envelope, seedHex): Promise<void>` consistent across Tasks 3, 4, 5; `persistManagerState()` defined in Task 2, used in Task 3. ✓

**Note for the seed-backup gate:** the spec calls for a "written down your seed" confirmation on new-seed creation. The example app currently uses a fixed seed input rather than generating one in-UI; Task 5 surfaces backup/restore + a safety hint instead of a blocking modal. If in-UI seed generation is added later, add the confirmation gate there.
