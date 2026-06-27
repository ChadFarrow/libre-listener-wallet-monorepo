# Easy, Trustworthy Downloadable Backup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the user-downloaded encrypted backup trustworthy — the user always knows if their file is current, fixes it in one click, and a wiped browser is guided to restore.

**Architecture:** A small authoritative "state version" counter in the SDK (persisted, increments when the ChannelManager is persisted) drives example-app UX: a backup-status indicator, version bookkeeping on download, a restore-on-empty banner, and a seed-copy affordance. No server, no remote storage.

**Tech Stack:** TypeScript, LDK WASM, Vitest, the existing Phase 1 backup engine (`exportState`/`importState`), browser `localStorage`.

## Global Constraints

- No server, no remote storage, no Nostr, no silent auto-download — the user downloads and keeps the file.
- Encryption model unchanged (seed-derived AES-256-GCM from Phase 1).
- No silent catches; functions camelCase; files kebab-case.
- App has no automated UI tests; `tsc && vite build` is the gate for example-app tasks.
- Spec: `docs/superpowers/specs/2026-06-26-easy-backup-ux-design.md`.

## File Structure

- Modify `packages/libre-listener-wallet/src/index.ts` — `stateVersion` field, load/persist, `getStateVersion()`.
- Create `packages/libre-listener-wallet/src/tests/unit/state-version.test.ts` — default + persisted-load.
- Modify `packages/libre-listener-wallet/src/tests/integration/recovery.test.ts` — assert version increments on a real channel change.
- Modify `packages/example-app/index.html` — backup-status text, restore banner, seed-copy button + reminder.
- Modify `packages/example-app/src/main.ts` — indicator refresh, download bookkeeping, restore banner, seed copy.

---

### Task 1: SDK state-version signal

**Files:**
- Modify: `packages/libre-listener-wallet/src/index.ts`
- Test: `packages/libre-listener-wallet/src/tests/unit/state-version.test.ts`
- Modify (integration assertion): `packages/libre-listener-wallet/src/tests/integration/recovery.test.ts`

**Interfaces:**
- Produces: `getStateVersion(): number` on `LibreListenerWallet` — a monotonic counter, persisted under storage key `state_version`, that increments each time the ChannelManager is persisted (channel opened, payment, etc.). Starts at 0 for a fresh wallet; loads the persisted value on `start()`.

- [ ] **Step 1: Write the failing unit test**

Create `packages/libre-listener-wallet/src/tests/unit/state-version.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { LibreListenerWallet, SecureStorageProvider, WebSocketStreamProvider } from "../../index";
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
const noSocket: WebSocketStreamProvider = { connect: async () => { throw new Error("not used"); } };
function makeStorage(db: Map<string, string>): SecureStorageProvider {
  return {
    getItem: async (k) => db.get(k) ?? null,
    setItem: async (k, v) => { db.set(k, v); },
    removeItem: async (k) => { db.delete(k); },
  };
}

describe("getStateVersion", () => {
  let wasmBinary: Uint8Array;
  beforeAll(() => { wasmBinary = loadWasmBinary(); mswServer.listen({ onUnhandledRequest: "bypass" }); });
  afterEach(() => mswServer.resetHandlers());
  afterAll(() => mswServer.close());

  it("is 0 for a fresh wallet", async () => {
    const wallet = new LibreListenerWallet({ config: { network: "regtest", esploraUrl }, storage: makeStorage(new Map()), socketProvider: noSocket, wasmBinary });
    await wallet.start();
    expect(wallet.getStateVersion()).toBe(0);
    await wallet.stop();
  });

  it("loads the persisted state_version on start", async () => {
    const db = new Map<string, string>();
    db.set("state_version", "7");
    const wallet = new LibreListenerWallet({ config: { network: "regtest", esploraUrl }, storage: makeStorage(db), socketProvider: noSocket, wasmBinary });
    await wallet.start();
    expect(wallet.getStateVersion()).toBe(7);
    await wallet.stop();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/state-version.test.ts`
Expected: FAIL — `wallet.getStateVersion is not a function`.

- [ ] **Step 3: Add the field, load, increment, and getter**

In `packages/libre-listener-wallet/src/index.ts`:

(a) Add the field next to the other private counters (near `private nextDescriptorId: number = 1;`):

```ts
  private stateVersion: number = 0;
```

(b) In `start()`, immediately after the storage cache loads:

```ts
    // 2. Load storage cache
    this.storageCache = new StorageCache(this.storage);
    await this.storageCache.load();
```

add:

```ts
    const storedVersion = await this.storage.getItem("state_version");
    this.stateVersion = storedVersion ? parseInt(storedVersion, 10) || 0 : 0;
```

(c) In the event tick, inside the existing `get_and_clear_needs_persistence()` block, bump and persist the version right after the `channel_manager` write:

```ts
        if (this.channelManager.get_and_clear_needs_persistence()) {
          this.storage
            .setItem("channel_manager", bytesToHex(this.channelManager.write()))
            .catch((err) =>
              this.logger?.error(`Failed to persist channel_manager: ${err instanceof Error ? err.message : err}`)
            );
          this.stateVersion++;
          this.storage
            .setItem("state_version", String(this.stateVersion))
            .catch((err) =>
              this.logger?.error(`Failed to persist state_version: ${err instanceof Error ? err.message : err}`)
            );
        }
```

(d) Add the getter directly below `status()`:

```ts
  getStateVersion(): number {
    return this.stateVersion;
  }
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/state-version.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add an increment assertion to the recovery integration test**

In `packages/libre-listener-wallet/src/tests/integration/recovery.test.ts`, find the line that asserts the funded channel count on wallet A:

```ts
    const channelsA = walletA.getChannelManager()!.list_channels().length;
    expect(channelsA).toBe(1);
```

Add immediately after it:

```ts
    // Opening + funding the channel changed state, so the version must have advanced.
    expect(walletA.getStateVersion()).toBeGreaterThan(0);
```

And after wallet B is started (find `expect(walletB.getChannelManager()!.list_channels().length).toBe(1);`), add immediately after it:

```ts
    // The restored wallet loaded the persisted state_version (non-zero).
    expect(walletB.getStateVersion()).toBeGreaterThan(0);
```

- [ ] **Step 6: Run the recovery integration test (requires the regtest stack)**

Run (bring the stack up first if needed: `docker compose up -d && ./scripts/regtest-setup.sh`):
`pnpm --filter @libre/listener-wallet exec vitest run src/tests/integration/recovery.test.ts`
Expected: PASS (1 test) — including the two new `getStateVersion()` assertions.

- [ ] **Step 7: Build and commit**

```bash
pnpm --filter @libre/listener-wallet build
git add packages/libre-listener-wallet/src/index.ts packages/libre-listener-wallet/src/tests/unit/state-version.test.ts packages/libre-listener-wallet/src/tests/integration/recovery.test.ts
git commit -m "feat: add getStateVersion() — persisted monotonic channel-state version"
```

---

### Task 2: Backup-status indicator + download bookkeeping

**Files:**
- Modify: `packages/example-app/index.html`
- Modify: `packages/example-app/src/main.ts`

**Interfaces:**
- Consumes: `wallet.getStateVersion()` (Task 1); the existing `exportStateBtn` handler and `wallet`/`isNodeRunning` globals.

- [ ] **Step 1: Add the status line to the Backup card**

In `packages/example-app/index.html`, change the backup button block (the `export-state-btn` line):

```html
          <button id="export-state-btn" class="btn btn-primary" disabled>Download Encrypted Backup</button>
```

to:

```html
          <div class="status-row" style="margin-bottom: 10px;">
            <span class="label">Backup status:</span>
            <span id="backup-status" class="value">—</span>
          </div>
          <button id="export-state-btn" class="btn btn-primary" disabled>Download Encrypted Backup</button>
```

- [ ] **Step 2: Add the lookup + refresh function in main.ts**

In `packages/example-app/src/main.ts`, next to the other Backup element lookups (near `const exportStateBtn = ...`), add:

```ts
const backupStatusEl = document.getElementById("backup-status") as HTMLSpanElement;
```

Then add this function and timer at the end of the file:

```ts
// Reflect whether the on-disk backup file is current vs. the wallet's channel state.
function refreshBackupStatus() {
  if (!wallet || !isNodeRunning) {
    backupStatusEl.textContent = "—";
    backupStatusEl.className = "value";
    return;
  }
  const current = wallet.getStateVersion();
  const lastStr = localStorage.getItem("libre_last_backup_version");
  const last = lastStr === null ? -1 : parseInt(lastStr, 10);
  if (last < 0) {
    backupStatusEl.textContent = "No backup yet — click Download";
    backupStatusEl.className = "value text-warning";
  } else if (current > last) {
    backupStatusEl.textContent = "⚠️ Out of date — click Download";
    backupStatusEl.className = "value text-warning";
  } else {
    backupStatusEl.textContent = "Up to date ✓";
    backupStatusEl.className = "value";
  }
}
setInterval(refreshBackupStatus, 2000);
```

- [ ] **Step 3: Record the version on a successful download**

In the existing `exportStateBtn` click handler, replace this line:

```ts
    appendLog("[SYSTEM] Encrypted backup downloaded. Keep it and your seed safe.", "system");
```

with:

```ts
    localStorage.setItem("libre_last_backup_version", String(wallet.getStateVersion()));
    refreshBackupStatus();
    appendLog("[SYSTEM] Encrypted backup downloaded. Keep it and your seed safe.", "system");
```

- [ ] **Step 4: Type-check + build**

Run: `pnpm --filter @libre/example-app build`
Expected: `tsc && vite build` succeeds, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/example-app/index.html packages/example-app/src/main.ts
git commit -m "feat: backup-status indicator + record version on download"
```

---

### Task 3: Restore-on-empty banner

**Files:**
- Modify: `packages/example-app/index.html`
- Modify: `packages/example-app/src/main.ts`

**Interfaces:**
- Consumes: the existing on-load seed-restore IIFE and `storage` global.

- [ ] **Step 1: Add the banner to the Backup card**

In `packages/example-app/index.html`, immediately after the `<h2>Backup &amp; Recovery</h2>` line, add:

```html
          <div id="restore-banner" class="help-text text-warning hidden" style="margin-bottom: 10px;">
            No wallet found in this browser. If you have a backup file, restore it below (you'll need your seed).
          </div>
```

- [ ] **Step 2: Toggle the banner from the on-load restore logic**

In `packages/example-app/src/main.ts`, add a lookup near the other Backup lookups:

```ts
const restoreBanner = document.getElementById("restore-banner") as HTMLDivElement;
```

In the existing on-load IIFE, replace the seed-restore block:

```ts
  try {
    const storedSeed = await storage.getItem("ldk_seed");
    if (storedSeed && /^[0-9a-fA-F]{64}$/.test(storedSeed)) {
      seedInput.value = storedSeed;
      appendLog("[SYSTEM] Restored existing wallet seed and network from storage.", "system");
    }
  } catch {}
```

with:

```ts
  try {
    const storedSeed = await storage.getItem("ldk_seed");
    if (storedSeed && /^[0-9a-fA-F]{64}$/.test(storedSeed)) {
      seedInput.value = storedSeed;
      restoreBanner.classList.add("hidden");
      appendLog("[SYSTEM] Restored existing wallet seed and network from storage.", "system");
    } else {
      // Fresh/wiped browser — guide the user to restore from their backup file.
      restoreBanner.classList.remove("hidden");
    }
  } catch {}
```

- [ ] **Step 3: Type-check + build**

Run: `pnpm --filter @libre/example-app build`
Expected: succeeds, no type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/example-app/index.html packages/example-app/src/main.ts
git commit -m "feat: show restore-from-backup banner when no wallet exists"
```

---

### Task 4: Seed-copy affordance

**Files:**
- Modify: `packages/example-app/index.html`
- Modify: `packages/example-app/src/main.ts`

**Interfaces:**
- Consumes: the existing `seedInput` element and `appendLog`.

- [ ] **Step 1: Add a Copy button + reminder to the seed row**

In `packages/example-app/index.html`, change the seed input-action-row:

```html
            <div class="input-action-row">
              <input type="password" id="seed-input" value="0000000000000000000000000000000000000000000000000000000000000001" placeholder="Enter 32-byte hex seed" />
              <button id="toggle-seed-btn" class="btn btn-secondary">Show</button>
              <button id="new-wallet-btn" class="btn btn-secondary">New Wallet</button>
            </div>
```

to:

```html
            <div class="input-action-row">
              <input type="password" id="seed-input" value="0000000000000000000000000000000000000000000000000000000000000001" placeholder="Enter 32-byte hex seed" />
              <button id="toggle-seed-btn" class="btn btn-secondary">Show</button>
              <button id="copy-seed-btn" class="btn btn-secondary">Copy</button>
              <button id="new-wallet-btn" class="btn btn-secondary">New Wallet</button>
            </div>
            <p class="help-text text-warning">Your seed is your master backup — save it. It recovers your funds even without a backup file.</p>
```

- [ ] **Step 2: Wire the Copy button**

In `packages/example-app/src/main.ts`, add a lookup near the seed elements:

```ts
const copySeedBtn = document.getElementById("copy-seed-btn") as HTMLButtonElement;
```

Add the handler at the end of the file:

```ts
copySeedBtn.addEventListener("click", async () => {
  const seed = seedInput.value.trim();
  if (seed.length !== 64) {
    appendLog("[ERROR] No 64-char seed to copy.", "error");
    return;
  }
  try {
    await navigator.clipboard.writeText(seed);
    appendLog("[SYSTEM] Seed copied to clipboard — store it somewhere safe.", "system");
  } catch (e) {
    appendLog(`[ERROR] Copy failed: ${e instanceof Error ? e.message : e}`, "error");
  }
});
```

- [ ] **Step 3: Type-check + build**

Run: `pnpm --filter @libre/example-app build`
Expected: succeeds, no type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/example-app/index.html packages/example-app/src/main.ts
git commit -m "feat: add Copy-seed button and master-backup reminder"
```

---

## Self-Review

**Spec coverage:**
- Component 1 (SDK state-changed signal) → Task 1. ✓
- Component 2 (status indicator + one-click download + version bookkeeping) → Task 2. ✓
- Component 3 (restore-on-empty prompt) → Task 3. ✓
- Component 4 (seed easy to save) → Task 4. ✓
- Non-goals (no server/remote/Nostr/auto-save) → nothing added implements them. ✓
- Testing strategy (getStateVersion 0/persist + increment on real change; app build gate) → Task 1 unit + recovery assertion; Tasks 2–4 build gate. ✓

**Placeholder scan:** No TBD/TODO; every step has concrete code/commands. ✓

**Type consistency:** `getStateVersion(): number` defined in Task 1 and consumed identically in Task 2; storage key `state_version` and localStorage key `libre_last_backup_version` used consistently; element ids (`backup-status`, `restore-banner`, `copy-seed-btn`) match between the HTML and the `main.ts` lookups. ✓

**Note:** `text-warning` is an existing CSS class in the app (used by `stream-mode-status`); the `status-row`/`label`/`value` classes are reused from the existing status box. No new CSS required.
