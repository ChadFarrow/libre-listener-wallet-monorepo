# Rock-Solid Backup & Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make wallet backups recoverable from either a passphrase or the seed (envelope encryption), block wallet creation in non-persistent storage, and verify recovery end-to-end before any funds are added.

**Architecture:** Replace the seed-only HKDF backup with **envelope encryption** — one random data-encryption-key (DEK) encrypts the payload, and the DEK is wrapped to *both* a passphrase (PBKDF2) and the seed (HKDF), so either secret opens the backup. The SDK stays platform-free and stateless about the passphrase; the example-app adds a persistent-storage guard, a show-seed-and-confirm creation flow, passphrase-encrypted Drive auto-sync, and a pre-funding verified round-trip.

**Tech Stack:** TypeScript, WebCrypto (`crypto.subtle`) — no new dependencies, Vitest (jsdom for wallet/app, node for gateway), pnpm + Turborepo.

## Global Constraints

- Package manager: **pnpm@10.10.0**; build via Turborepo. (verbatim from repo)
- SDK (`@libre/listener-wallet`) MUST NOT import platform modules (`window`, `navigator`, `fs`). Storage/transport/logging are injected. The persistent-storage guard lives in the **example-app**, not the SDK. (guardrail)
- No new runtime dependencies — crypto is WebCrypto only (browser + Node ≥18 `globalThis.crypto`).
- Secrets (seed, passphrase, preimages) MUST never be logged or sent over any socket/HTTP. Backups are encrypted locally before leaving the device. (guardrail)
- TDD mandatory: red → green → refactor. Do NOT mock LDK internals; use real LDK WASM and real (in-memory/jsdom) storage. Assert outcomes, not call order. (testing-strategy)
- Files: kebab-case; Types: PascalCase; vars/functions: camelCase.
- Never commit to `master` directly and never commit without human approval — create a feature branch. (CLAUDE.md)

---

## File Structure

- `packages/libre-listener-wallet/src/state-backup.ts` — **modified**. Add v2 envelope encryption (PBKDF2 + HKDF dual-wrap), version-detecting decrypt, keep v1 read + a retained `serializeAndEncryptV1` for back-compat/tests.
- `packages/libre-listener-wallet/src/tests/unit/state-backup.test.ts` — **modified/extended**. v2 round-trips (passphrase + seed), wrong-secret, tamper, v1 back-compat.
- `packages/libre-listener-wallet/src/index.ts` — **modified**. `exportState({passphrase})`, `importState(env, secret)`, new `verifyBackup`.
- `packages/libre-listener-wallet/src/tests/unit/export-import.test.ts` — **create**. Real-storage export→import round-trip via passphrase and via seed; `verifyBackup`.
- `packages/example-app/src/core/persistent-storage.ts` — **create**. `ensurePersistentStorage()`.
- `packages/example-app/src/core/persistent-storage.test.ts` — **create**. Guard behavior with stubbed `navigator.storage`.
- `packages/example-app/src/main.ts` — **modified**. New-wallet flow (guard + show/confirm seed + passphrase), `createAndVerifyBackup`, restore accepts passphrase.
- `packages/example-app/index.html` — **modified**. Remove the hardcoded default seed value; add passphrase + seed-confirm fields.

---

## Task 0: Feature branch

- [ ] **Step 1: Create and switch to a feature branch**

Run:
```bash
cd /Users/chad-mini/Vibe/libre-listener-wallet-monorepo
git checkout -b feat/rock-solid-backup
```
Expected: `Switched to a new branch 'feat/rock-solid-backup'`

---

## Task 1: v2 envelope crypto helpers + encrypt/decrypt (passphrase recipient)

**Files:**
- Modify: `packages/libre-listener-wallet/src/state-backup.ts`
- Test: `packages/libre-listener-wallet/src/tests/unit/state-backup.test.ts`

**Interfaces:**
- Consumes: `hexToBytes`, `bytesToHex` from `./storage-cache`; existing `BackupPayload`.
- Produces:
  - `serializeAndEncrypt(payload: BackupPayload, secrets: { passphrase: string; seedHex: string }): Promise<string>` (v2)
  - `decryptAndParse(envelopeStr: string, secret: string): Promise<BackupPayload>` (detects v2/v1)
  - retained `serializeAndEncryptV1(payload: BackupPayload, seedHex: string): Promise<string>` (legacy/tests)

- [ ] **Step 1: Write the failing test (passphrase round-trip)**

Add to `state-backup.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { serializeAndEncrypt, decryptAndParse } from "../../state-backup";

const seedHex = "11".repeat(32); // 64 hex chars
const payload = {
  version: 1 as const,
  network: "regtest",
  exportedAt: 1700000000000,
  entries: { ldk_seed: seedHex, channel_manager: "deadbeef", state_version: "3" },
};

describe("state-backup v2", () => {
  it("round-trips when decrypted with the passphrase", async () => {
    const env = await serializeAndEncrypt(payload, { passphrase: "correct horse battery staple", seedHex });
    const parsed = JSON.parse(env);
    expect(parsed.v).toBe(2);
    expect(parsed.recipients.map((r: any) => r.type).sort()).toEqual(["passphrase", "seed"]);
    const out = await decryptAndParse(env, "correct horse battery staple");
    expect(out).toEqual(payload);
  });

  it("fails with the wrong passphrase", async () => {
    const env = await serializeAndEncrypt(payload, { passphrase: "right", seedHex });
    await expect(decryptAndParse(env, "wrong")).rejects.toThrow(/Decryption failed/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/state-backup.test.ts`
Expected: FAIL — `serializeAndEncrypt` signature mismatch / `v` is not 2.

- [ ] **Step 3: Implement v2 helpers + passphrase recipient**

In `state-backup.ts`, keep the existing `bytesToBase64`/`base64ToBytes`/`hexToBytes` import, **rename** the current `deriveAesKey` to `deriveAesKeyV1` and the current `serializeAndEncrypt` to `serializeAndEncryptV1` (leave its body intact). Then add:

```ts
interface RecipientV2 {
  type: "passphrase" | "seed";
  kdf: "PBKDF2-SHA256" | "HKDF-SHA256";
  iter?: number;        // passphrase only
  salt?: string;        // passphrase only (base64)
  info?: string;        // seed only
  iv: string;           // base64, for the DEK wrap
  wrap: string;         // base64, AES-GCM(DEK) under the KEK
}
interface BackupEnvelopeV2 {
  v: 2;
  alg: "AES-256-GCM";
  iv: string;   // base64, payload IV
  ct: string;   // base64, payload ciphertext
  recipients: RecipientV2[];
}

const PBKDF2_ITER = 600000;
const SEED_KEK_INFO = "libre-wallet-backup-kek-v2";

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

async function deriveKekFromPassphrase(passphrase: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: iter },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function deriveKekFromSeed(seedHex: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", hexToBytes(seedHex), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(SEED_KEK_INFO) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function importDek(dek: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", dek, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function wrapDek(kek: CryptoKey, dek: Uint8Array): Promise<{ iv: string; wrap: string }> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, dek);
  return { iv: bytesToBase64(iv), wrap: bytesToBase64(new Uint8Array(ct)) };
}

export async function serializeAndEncrypt(
  payload: BackupPayload,
  secrets: { passphrase: string; seedHex: string }
): Promise<string> {
  const dek = randomBytes(32);
  const dekKey = await importDek(dek);
  const iv = randomBytes(12);
  const ctBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    dekKey,
    new TextEncoder().encode(JSON.stringify(payload))
  );

  const salt = randomBytes(16);
  const passKek = await deriveKekFromPassphrase(secrets.passphrase, salt, PBKDF2_ITER);
  const passWrap = await wrapDek(passKek, dek);
  const seedKek = await deriveKekFromSeed(secrets.seedHex);
  const seedWrap = await wrapDek(seedKek, dek);

  const envelope: BackupEnvelopeV2 = {
    v: 2,
    alg: "AES-256-GCM",
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ctBuf)),
    recipients: [
      { type: "passphrase", kdf: "PBKDF2-SHA256", iter: PBKDF2_ITER, salt: bytesToBase64(salt), iv: passWrap.iv, wrap: passWrap.wrap },
      { type: "seed", kdf: "HKDF-SHA256", info: SEED_KEK_INFO, iv: seedWrap.iv, wrap: seedWrap.wrap },
    ],
  };
  return JSON.stringify(envelope);
}
```

Then replace `decryptAndParse` with a version dispatcher (seed recipient unwrap added in Task 2; for now handle passphrase + leave a seed branch that will be exercised next task):

```ts
export async function decryptAndParse(envelopeStr: string, secret: string): Promise<BackupPayload> {
  let env: any;
  try { env = JSON.parse(envelopeStr); } catch { throw new Error("Invalid backup: not valid JSON"); }
  if (env.v === 2) return decryptV2(env as BackupEnvelopeV2, secret);
  if (env.v === 1) return decryptV1(env, secret);
  throw new Error(`Unsupported backup version: ${env.v}`);
}

async function unwrapDek(kek: CryptoKey, ivB64: string, wrapB64: string): Promise<Uint8Array> {
  const out = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(ivB64) }, kek, base64ToBytes(wrapB64));
  return new Uint8Array(out);
}

async function decryptV2(env: BackupEnvelopeV2, secret: string): Promise<BackupPayload> {
  const isHex = /^[0-9a-fA-F]{64}$/.test(secret);
  const order: Array<"seed" | "passphrase"> = isHex ? ["seed", "passphrase"] : ["passphrase", "seed"];
  let dek: Uint8Array | null = null;
  for (const t of order) {
    const r = env.recipients.find((x) => x.type === t);
    if (!r) continue;
    try {
      const kek = t === "passphrase"
        ? await deriveKekFromPassphrase(secret, base64ToBytes(r.salt as string), r.iter as number)
        : await deriveKekFromSeed(secret);
      dek = await unwrapDek(kek, r.iv, r.wrap);
      break;
    } catch { /* try the next recipient */ }
  }
  if (!dek) throw new Error("Decryption failed — wrong secret or corrupt backup");
  const dekKey = await importDek(dek);
  let ptBuf: ArrayBuffer;
  try {
    ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(env.iv) }, dekKey, base64ToBytes(env.ct));
  } catch {
    throw new Error("Decryption failed — wrong secret or corrupt backup");
  }
  return JSON.parse(new TextDecoder().decode(ptBuf)) as BackupPayload;
}

async function decryptV1(env: any, seedHex: string): Promise<BackupPayload> {
  if (typeof env.iv !== "string" || typeof env.ct !== "string") {
    throw new Error("Decryption failed — wrong secret or corrupt backup");
  }
  const key = await deriveAesKeyV1(seedHex);
  let ptBuf: ArrayBuffer;
  try {
    ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(env.iv) }, key, base64ToBytes(env.ct));
  } catch {
    throw new Error("Decryption failed — wrong secret or corrupt backup");
  }
  return JSON.parse(new TextDecoder().decode(ptBuf)) as BackupPayload;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/state-backup.test.ts`
Expected: PASS (passphrase round-trip + wrong-passphrase).

- [ ] **Step 5: Commit**

```bash
git add packages/libre-listener-wallet/src/state-backup.ts packages/libre-listener-wallet/src/tests/unit/state-backup.test.ts
git commit -m "feat(sdk): v2 backup envelope encryption with passphrase recipient"
```

---

## Task 2: Seed recipient (dual-wrap) — decrypt with the seed

**Files:**
- Modify: `packages/libre-listener-wallet/src/state-backup.ts` (already wired in Task 1; this task proves the seed path)
- Test: `packages/libre-listener-wallet/src/tests/unit/state-backup.test.ts`

**Interfaces:**
- Consumes: `serializeAndEncrypt`, `decryptAndParse` from Task 1.
- Produces: no new symbols (validates the `seed` recipient branch).

- [ ] **Step 1: Write the failing test (seed round-trip + tamper)**

Add to `state-backup.test.ts`:
```ts
it("round-trips when decrypted with the seed (64-hex)", async () => {
  const env = await serializeAndEncrypt(payload, { passphrase: "pw", seedHex });
  const out = await decryptAndParse(env, seedHex);
  expect(out).toEqual(payload);
});

it("fails with a wrong seed", async () => {
  const env = await serializeAndEncrypt(payload, { passphrase: "pw", seedHex });
  await expect(decryptAndParse(env, "22".repeat(32))).rejects.toThrow(/Decryption failed/);
});

it("detects tampering of the ciphertext", async () => {
  const env = JSON.parse(await serializeAndEncrypt(payload, { passphrase: "pw", seedHex }));
  const ctBytes = Buffer.from(env.ct, "base64"); ctBytes[0] ^= 0xff; env.ct = ctBytes.toString("base64");
  await expect(decryptAndParse(JSON.stringify(env), "pw")).rejects.toThrow(/Decryption failed/);
});
```

- [ ] **Step 2: Run to verify**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/state-backup.test.ts`
Expected: PASS — the seed branch implemented in Task 1 already satisfies these. If the seed round-trip fails, fix `decryptV2`'s `deriveKekFromSeed` call (it must use the same empty salt + `SEED_KEK_INFO`).

- [ ] **Step 3: Commit**

```bash
git add packages/libre-listener-wallet/src/tests/unit/state-backup.test.ts
git commit -m "test(sdk): backup recoverable via seed and rejects tampering"
```

---

## Task 3: v1 backward-compat read

**Files:**
- Modify: `packages/libre-listener-wallet/src/state-backup.ts` (ensure `serializeAndEncryptV1` exported)
- Test: `packages/libre-listener-wallet/src/tests/unit/state-backup.test.ts`

**Interfaces:**
- Consumes: `serializeAndEncryptV1(payload, seedHex)` (legacy), `decryptAndParse`.
- Produces: none.

- [ ] **Step 1: Write the failing test**

```ts
import { serializeAndEncryptV1 } from "../../state-backup";

it("still decrypts a legacy v1 (seed-HKDF) backup", async () => {
  const env = await serializeAndEncryptV1(payload, seedHex); // v1 envelope
  expect(JSON.parse(env).v).toBe(1);
  const out = await decryptAndParse(env, seedHex);
  expect(out).toEqual(payload);
});
```

- [ ] **Step 2: Run to verify it fails (if `serializeAndEncryptV1` not exported)**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/state-backup.test.ts`
Expected: FAIL — `serializeAndEncryptV1 is not exported` (or PASS if Task 1 already exported it).

- [ ] **Step 3: Ensure `serializeAndEncryptV1` is exported**

Confirm the renamed legacy function is `export async function serializeAndEncryptV1(payload: BackupPayload, seedHex: string): Promise<string>` and it sets `v: 1` in its envelope.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/state-backup.test.ts`
Expected: PASS (all state-backup tests).

- [ ] **Step 5: Commit**

```bash
git add packages/libre-listener-wallet/src/state-backup.ts packages/libre-listener-wallet/src/tests/unit/state-backup.test.ts
git commit -m "test(sdk): v1 backups remain decryptable for back-compat"
```

---

## Task 4: SDK `exportState` / `importState` / `verifyBackup`

**Files:**
- Modify: `packages/libre-listener-wallet/src/index.ts:843-895` (exportState/importState region)
- Test: `packages/libre-listener-wallet/src/tests/unit/export-import.test.ts` (create)

**Interfaces:**
- Consumes: `serializeAndEncrypt`, `serializeAndEncryptV1`, `decryptAndParse` (state-backup); `IndexedDBStorageProvider` (real storage in jsdom); `BackupPayload`.
- Produces:
  - `exportState(opts?: { passphrase?: string }): Promise<string>`
  - `importState(envelope: string, secret: string): Promise<void>`
  - `verifyBackup(envelope: string, secret: string): Promise<{ ok: boolean; network?: string; hasSeed: boolean; seedMatches?: boolean; entryKeys: string[]; error?: string }>`

- [ ] **Step 1: Write the failing test (round-trip via passphrase and via seed, into real storage)**

Create `export-import.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import "fake-indexeddb/auto"; // jsdom IndexedDB (already used elsewhere in this package)
import { LibreListenerWallet } from "../../index";
import { IndexedDBStorageProvider } from "../../indexed-db-storage";

const seedHex = "33".repeat(32);

function makeWallet(storage: IndexedDBStorageProvider) {
  return new LibreListenerWallet({
    config: { network: "regtest", esploraUrl: "http://127.0.0.1:3002" },
    storage,
    // socketProvider/wasmUrl not needed for export/import (no start())
  } as any);
}

async function seedStorage(storage: IndexedDBStorageProvider) {
  await storage.setItem("ldk_seed", seedHex);
  await storage.setItem("channel_manager", "cafebabe");
  await storage.setItem("ldk_keys_index", JSON.stringify(["mon/abc"]));
  await storage.setItem("mon/abc", "0011");
  await storage.setItem("state_version", "5");
}

describe("exportState/importState v2", () => {
  it("restores all entries when importing with the passphrase", async () => {
    const src = new IndexedDBStorageProvider("libre-src-pw");
    await seedStorage(src);
    const env = await makeWallet(src).exportState({ passphrase: "pw-123" });

    const dst = new IndexedDBStorageProvider("libre-dst-pw");
    await makeWallet(dst).importState(env, "pw-123");
    expect(await dst.getItem("ldk_seed")).toBe(seedHex);
    expect(await dst.getItem("mon/abc")).toBe("0011");
    expect(await dst.getItem("channel_manager")).toBe("cafebabe");
  });

  it("restores when importing with the seed", async () => {
    const src = new IndexedDBStorageProvider("libre-src-seed");
    await seedStorage(src);
    const env = await makeWallet(src).exportState({ passphrase: "pw-xyz" });

    const dst = new IndexedDBStorageProvider("libre-dst-seed");
    await makeWallet(dst).importState(env, seedHex);
    expect(await dst.getItem("ldk_seed")).toBe(seedHex);
  });

  it("verifyBackup reports metadata without writing storage", async () => {
    const src = new IndexedDBStorageProvider("libre-src-verify");
    await seedStorage(src);
    const env = await makeWallet(src).exportState({ passphrase: "pw" });

    const probe = new IndexedDBStorageProvider("libre-probe");
    const res = await makeWallet(probe).verifyBackup(env, "pw");
    expect(res.ok).toBe(true);
    expect(res.hasSeed).toBe(true);
    expect(res.network).toBe("regtest");
    expect(await probe.getItem("ldk_seed")).toBeNull(); // not written
  });
});
```
> Note: if this package's tests use a different IndexedDB shim than `fake-indexeddb/auto`, match the existing import used by other unit tests in `src/tests/unit/`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/export-import.test.ts`
Expected: FAIL — `exportState` doesn't accept opts / `verifyBackup` undefined.

- [ ] **Step 3: Update the SDK methods**

In `index.ts`, replace the `exportState`/`importState` region (currently ~843-895). Keep the entries-collection logic; change only encryption + signatures, and add `verifyBackup`:

```ts
async exportState(opts?: { passphrase?: string }): Promise<string> {
  if (this.isRunning) {
    await this.persistManagerState();
  }
  const seedHex = await this.storage.getItem("ldk_seed");
  if (!seedHex) {
    throw new Error("Cannot export: no wallet seed found in storage");
  }

  const entries: Record<string, string> = {};
  const directKeys = ["ldk_seed", "channel_manager", "network_graph", "scorer", "ldk_keys_index", "state_version"];
  for (const k of directKeys) {
    const v = await this.storage.getItem(k);
    if (v !== null) entries[k] = v;
  }
  const indexStr = entries["ldk_keys_index"];
  if (indexStr) {
    let keyList: string[] = [];
    try { keyList = JSON.parse(indexStr); }
    catch (err) { throw new Error(`Cannot export: ldk_keys_index is malformed — ${(err as Error).message}`); }
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
  if (opts?.passphrase) {
    return serializeAndEncrypt(payload, { passphrase: opts.passphrase, seedHex });
  }
  return serializeAndEncryptV1(payload, seedHex); // legacy path (tests/back-compat)
}

async importState(envelope: string, secret: string): Promise<void> {
  if (this.isRunning) {
    throw new Error("Cannot import while running — create a fresh wallet and import before start()");
  }
  const payload = await decryptAndParse(envelope, secret);
  if (payload.network !== this.config.network) {
    throw new Error(`Backup network mismatch: backup is "${payload.network}" but wallet is configured for "${this.config.network}"`);
  }
  for (const [k, v] of Object.entries(payload.entries)) {
    await this.storage.setItem(k, v);
  }
}

async verifyBackup(envelope: string, secret: string): Promise<{
  ok: boolean; network?: string; hasSeed: boolean; seedMatches?: boolean; entryKeys: string[]; error?: string;
}> {
  try {
    const payload = await decryptAndParse(envelope, secret);
    const seedInBackup = payload.entries["ldk_seed"];
    const isHex = /^[0-9a-fA-F]{64}$/.test(secret);
    return {
      ok: true,
      network: payload.network,
      hasSeed: !!seedInBackup,
      seedMatches: isHex ? seedInBackup === secret : undefined,
      entryKeys: Object.keys(payload.entries),
    };
  } catch (e) {
    return { ok: false, hasSeed: false, entryKeys: [], error: e instanceof Error ? e.message : String(e) };
  }
}
```

Update the import line at the top of `index.ts` to include `serializeAndEncryptV1`:
```ts
import { serializeAndEncrypt, serializeAndEncryptV1, decryptAndParse, BackupPayload } from "./state-backup";
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/export-import.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the whole package suite**

Run: `pnpm --filter @libre/listener-wallet test`
Expected: PASS (no regressions; existing importState callers now pass a `secret` which is still a string).

- [ ] **Step 6: Commit**

```bash
git add packages/libre-listener-wallet/src/index.ts packages/libre-listener-wallet/src/tests/unit/export-import.test.ts
git commit -m "feat(sdk): exportState(passphrase), importState(secret), verifyBackup"
```

---

## Task 5: App persistent-storage guard

**Files:**
- Create: `packages/example-app/src/core/persistent-storage.ts`
- Create: `packages/example-app/src/core/persistent-storage.test.ts`

**Interfaces:**
- Produces: `ensurePersistentStorage(): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Create `persistent-storage.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ensurePersistentStorage } from "./persistent-storage";

describe("ensurePersistentStorage", () => {
  beforeEach(() => { (globalThis as any).navigator = {}; });

  it("returns false when Storage API is unavailable (incognito-like)", async () => {
    expect(await ensurePersistentStorage()).toBe(false);
  });

  it("returns true when already persisted", async () => {
    (globalThis as any).navigator = { storage: { persisted: async () => true, persist: async () => false } };
    expect(await ensurePersistentStorage()).toBe(true);
  });

  it("requests persistence when not yet persisted", async () => {
    const persist = vi.fn(async () => true);
    (globalThis as any).navigator = { storage: { persisted: async () => false, persist } };
    expect(await ensurePersistentStorage()).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
  });

  it("returns false when persistence is denied", async () => {
    (globalThis as any).navigator = { storage: { persisted: async () => false, persist: async () => false } };
    expect(await ensurePersistentStorage()).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @libre/example-app exec vitest run src/core/persistent-storage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the guard**

Create `persistent-storage.ts`:
```ts
// Returns true only if browser storage will survive the session (NOT Incognito).
// Lives in the app layer — the SDK must never touch `navigator`.
export async function ensurePersistentStorage(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage || !navigator.storage.persist) {
    return false;
  }
  if (await navigator.storage.persisted()) return true;
  return await navigator.storage.persist();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @libre/example-app exec vitest run src/core/persistent-storage.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/example-app/src/core/persistent-storage.ts packages/example-app/src/core/persistent-storage.test.ts
git commit -m "feat(app): persistent-storage guard to block non-durable (incognito) wallets"
```

---

## Task 6: HTML — remove default seed, add passphrase + seed-confirm fields

**Files:**
- Modify: `packages/example-app/index.html:36` (seed input) and the Backup/Recovery section.

**Interfaces:**
- Produces DOM ids consumed by Task 7: `seed-confirm-input`, `passphrase-input`, `passphrase-confirm-input`, `restore-passphrase-input`, `create-wallet-status`.

- [ ] **Step 1: Remove the hardcoded default seed**

Change `index.html:36` from:
```html
<input type="password" id="seed-input" value="0000000000000000000000000000000000000000000000000000000000000001" placeholder="Enter 32-byte hex seed" />
```
to:
```html
<input type="password" id="seed-input" value="" placeholder="Your 64-hex seed appears here on create / paste to restore" />
```

- [ ] **Step 2: Add creation + passphrase fields**

In the wallet/seed area add:
```html
<div id="create-wallet-fields">
  <label>Confirm seed (re-enter to prove you saved it)</label>
  <input type="text" id="seed-confirm-input" placeholder="Re-type the 64-hex seed shown above" />
  <label>Backup passphrase</label>
  <input type="password" id="passphrase-input" placeholder="Choose a strong passphrase (kept in your password manager)" />
  <input type="password" id="passphrase-confirm-input" placeholder="Confirm passphrase" />
  <span id="create-wallet-status" class="value">—</span>
</div>
```

In the Backup & Recovery / restore area add:
```html
<label>Restore passphrase (or paste your seed in the seed field above)</label>
<input type="password" id="restore-passphrase-input" placeholder="Passphrase used to encrypt the backup" />
```

- [ ] **Step 3: Verify the app still builds**

Run: `pnpm --filter @libre/example-app build`
Expected: build succeeds (no TS errors from `tsup`/Vite for the HTML change).

- [ ] **Step 4: Commit**

```bash
git add packages/example-app/index.html
git commit -m "feat(app): remove default seed; add passphrase + seed-confirm fields"
```

---

## Task 7: App — safe creation flow, verified round-trip, passphrase restore

**Files:**
- Modify: `packages/example-app/src/main.ts` — `newWalletBtn` handler (~587-621), `restoreDriveBtn` (~754-789), `importStateBtn` (~557-584), `uploadBackupToDrive` (~719), and add `createAndVerifyBackup`.

**Interfaces:**
- Consumes: `ensurePersistentStorage` (Task 5); `wallet.exportState({passphrase})`, `wallet.verifyBackup`, `wallet.importState` (Task 4); existing `drive` module (`uploadBackup`/`downloadBackup`/`isConnected`/`connect`), `storage`, `appendLog`, DOM ids from Task 6.
- Produces: in-session `backupPassphrase` (module variable, memory only), `createAndVerifyBackup(passphrase: string): Promise<boolean>`.

- [ ] **Step 1: Add imports + session passphrase + DOM refs**

Near the top of `main.ts`:
```ts
import { ensurePersistentStorage } from "./core/persistent-storage";

let backupPassphrase: string | null = null; // memory only; never persisted
let pendingSeed: string | null = null;       // seed shown but not yet confirmed/created

const seedConfirmInput = document.getElementById("seed-confirm-input") as HTMLInputElement;
const passphraseInput = document.getElementById("passphrase-input") as HTMLInputElement;
const passphraseConfirmInput = document.getElementById("passphrase-confirm-input") as HTMLInputElement;
const restorePassphraseInput = document.getElementById("restore-passphrase-input") as HTMLInputElement;
const createWalletStatus = document.getElementById("create-wallet-status") as HTMLSpanElement;
```

- [ ] **Step 2: Add `createAndVerifyBackup` (the pre-funding proof)**

```ts
// Exports the encrypted backup, uploads to Drive, re-downloads, and decrypts it
// back to prove recovery works BEFORE any funds are added. Returns true on success.
async function createAndVerifyBackup(passphrase: string): Promise<boolean> {
  if (!wallet) { appendLog("[ERROR] Start the node before verifying backup.", "error"); return false; }
  try {
    const env = await wallet.exportState({ passphrase });
    if (!drive.isConnected()) {
      const clientId = resolveClientId();
      if (!clientId) { appendLog("[ERROR] No Google Client ID — set VITE_GOOGLE_CLIENT_ID.", "error"); return false; }
      await drive.connect(clientId); updateDriveStatus();
    }
    await drive.uploadBackup(env);
    const redown = await drive.downloadBackup();
    if (!redown) { appendLog("[ERROR] Verify failed: backup not found in Drive after upload.", "error"); return false; }
    const res = await wallet.verifyBackup(redown, passphrase);
    if (!res.ok || !res.hasSeed || res.network !== networkSelect.value) {
      appendLog(`[ERROR] Backup verification FAILED: ${res.error ?? "mismatch"}. Do NOT fund this wallet.`, "error");
      createWalletStatus.textContent = "❌ Backup NOT verified";
      return false;
    }
    localStorage.setItem("libre_drive_synced_version", String(wallet.getStateVersion()));
    appendLog("[SYSTEM] ✅ Backup verified & restorable from Drive. Safe to receive funds.", "system");
    createWalletStatus.textContent = "✅ Backup verified & restorable from Drive";
    return true;
  } catch (e) {
    appendLog(`[ERROR] Verify failed: ${e instanceof Error ? e.message : e}`, "error");
    return false;
  }
}
```

- [ ] **Step 3: Rewrite the new-wallet handler (guard + show/confirm seed + passphrase)**

Replace the `newWalletBtn` click handler body with:
```ts
newWalletBtn.addEventListener("click", async () => {
  if (isNodeRunning) { appendLog("[ERROR] Stop the node before creating a new wallet.", "error"); return; }

  // 1) Refuse to create a wallet that won't survive the session (Incognito).
  if (!(await ensurePersistentStorage())) {
    appendLog("[ERROR] This browser will NOT persist wallet storage (Incognito or storage denied). " +
              "Open a normal window and allow storage before creating a wallet — otherwise your seed is lost on close.", "error");
    return;
  }

  // 2) Passphrase: required, entered twice, minimum length.
  const pass = passphraseInput.value;
  if (pass.length < 12) { appendLog("[ERROR] Choose a backup passphrase of at least 12 characters.", "error"); return; }
  if (pass !== passphraseConfirmInput.value) { appendLog("[ERROR] Passphrases do not match.", "error"); return; }

  // 3) Generate the seed once, show it, and require the user to confirm they saved it.
  //    First click: generate + show + stash in `pendingSeed` and return.
  //    Next click: proceed only if the Confirm box matches the SAME pending seed.
  if (!pendingSeed) {
    const seedBytes = new Uint8Array(32); crypto.getRandomValues(seedBytes);
    pendingSeed = Array.from(seedBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    seedInput.value = pendingSeed;
    seedInput.type = "text"; // reveal so they can copy it
    appendLog("[SYSTEM] New seed generated and shown above. SAVE IT (paper/Bitwarden), " +
              "then paste it into the ‘Confirm seed’ box and click New Wallet again to proceed.", "system");
    return;
  }
  const seedHex = pendingSeed;
  if (seedConfirmInput.value.trim() !== seedHex) {
    appendLog("[ERROR] Confirm-seed does not match the seed shown above. Paste it exactly to proceed.", "error");
    return;
  }

  // 4) Existing wallet guard.
  const existing = await storage.getItem("ldk_seed");
  if (existing && !window.confirm("Replace the wallet in this browser? Make sure you have a verified backup first.")) {
    appendLog("[SYSTEM] New wallet cancelled.", "system"); return;
  }

  // 5) Wipe + write the new seed.
  await storage.clear();
  await storage.setItem("ldk_seed", seedHex);
  backupPassphrase = pass;
  pendingSeed = null; // consumed
  nodeIdVal.innerText = "-";
  appendLog("[SYSTEM] New wallet created. Start the node, then it will verify your backup before you fund it.", "system");
  createWalletStatus.textContent = "Wallet created — start node to verify backup";
});
```

- [ ] **Step 4: Trigger verification after start; gate funding UI**

In the node-start success path (where `isNodeRunning` becomes true and `exportStateBtn.disabled = false`), append:
```ts
if (backupPassphrase) {
  const ok = await createAndVerifyBackup(backupPassphrase);
  if (!ok) appendLog("[ERROR] Backup not verified — do not receive funds until this succeeds.", "error");
}
```

- [ ] **Step 5: Encrypt Drive auto-sync with the session passphrase**

In `uploadBackupToDrive`, change the export call to use the passphrase:
```ts
if (!backupPassphrase) { appendLog("[SYSTEM] Skipping Drive sync — no session passphrase set.", "system"); return; }
const env = await wallet.exportState({ passphrase: backupPassphrase });
await drive.uploadBackup(env);
```
(Replace the existing `wallet.exportState()` call inside that function.)

- [ ] **Step 6: Accept passphrase OR seed on restore**

In `restoreDriveBtn` and `importStateBtn`, replace the seed-only secret with: prefer the seed field if it holds 64 hex, else use the passphrase field. Example for `restoreDriveBtn`:
```ts
const seedVal = seedInput.value.trim();
const secret = /^[0-9a-fA-F]{64}$/.test(seedVal) ? seedVal : restorePassphraseInput.value.trim();
if (!secret) { appendLog("[ERROR] Enter your passphrase (or paste your 64-hex seed) to restore.", "error"); return; }
// ...download blob as today...
await importWallet.importState(blob, secret);
if (!/^[0-9a-fA-F]{64}$/.test(seedVal)) backupPassphrase = secret; // remember passphrase for this session's auto-sync
```
Apply the same `secret` selection to `importStateBtn` (file restore), replacing its current 64-hex seed requirement.

- [ ] **Step 7: Typecheck/build the app**

Run: `pnpm --filter @libre/example-app build`
Expected: build succeeds.

- [ ] **Step 8: Commit**

```bash
git add packages/example-app/src/main.ts
git commit -m "feat(app): guarded creation, verified backup before funding, passphrase restore"
```

---

## Task 8: Full suite + manual verification

- [ ] **Step 1: Run all tests**

Run: `pnpm test`
Expected: all packages PASS.

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 3: Manual smoke (regtest, normal browser window — NOT incognito)**

1. `docker compose up -d` then `pnpm --filter @libre/example-app dev`.
2. Open `http://localhost:5173` in a **normal** window. Select **regtest**.
3. Click **New Wallet** → confirm it shows a seed and asks you to save+confirm. Paste the seed into Confirm, set a passphrase twice, click again → wallet created.
4. **Start** the node → log shows `✅ Backup verified & restorable from Drive` (with Drive connected) or the local verify path.
5. In a fresh profile/window: paste only the **passphrase** (leave seed blank) → **Restore from Drive** → **Start** → same node id returns. Repeat restoring with the **seed** instead → also returns.
6. Open an **Incognito** window → **New Wallet** is refused with the persistence warning.

- [ ] **Step 4: Confirm with the human, then push the branch (only on approval)**

Do not merge to `master` without approval. When approved:
```bash
git push -u origin feat/rock-solid-backup
```

---

## Notes for the implementer
- Line numbers are approximate — locate by symbol (`exportState`, `newWalletBtn`, `uploadBackupToDrive`, `restoreDriveBtn`).
- Keep the SDK free of `navigator`/`window`. The guard and all DOM live in the app.
- Never log seed or passphrase values.
- The 22 MB network-graph backups make `verifyBackup` do a full AES-GCM pass — fine for one verification, but keep Drive auto-sync debounced (existing behavior).
