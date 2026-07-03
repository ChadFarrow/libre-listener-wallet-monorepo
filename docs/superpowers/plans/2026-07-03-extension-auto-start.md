# Browser Extension Auto-Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The extension wallet starts its LDK node (and reconnects a funded wallet's channel peer) automatically whenever the offscreen document is created — browser launch, install/update, or lazy creation — with a default-on popup toggle.

**Architecture:** Approach A from the approved spec (`docs/superpowers/specs/2026-07-03-extension-auto-start-design.md`): the auto-start logic lives in the offscreen document's boot (`host.autoStart()`, non-throwing); the background service worker only adds `onStartup`/`onInstalled` listeners that call the existing `ensureOffscreen()`. Decision logic is a pure function mirroring the PWA's `assessStartReadiness` (a seed with no channel state that wasn't created here NEVER auto-starts — force-close guard). The channel peer becomes a persisted `ExtensionConfig.peer` field, saved on every successful manual connect.

**Tech Stack:** TypeScript, MV3 extension APIs (`chrome.storage.local`, `chrome.runtime`, `chrome.offscreen`), vitest (node env, pure-logic tests only — package convention).

## Global Constraints

- Package: `packages/browser-extension` (`@libre/browser-extension`). Files kebab-case; no deep relative imports across packages.
- TDD mandatory: failing test → minimal implementation → pass → commit. Do NOT mock LDK; the new unit tests are pure (no chrome, no LDK, no DOM) per package convention.
- The stateless-seed force-close guard must hold in TWO layers: `autoStartPlan` silently skips, AND `startNode()` keeps throwing (untouched).
- `ExtensionConfig.peer` is ADDITIVE under the existing `ldk_config` key — `pnpm check:storage` must stay green with NO contract-test edits.
- ESLint `no-floating-promises`/`no-misused-promises` are errors: mark fire-and-forget with `void`.
- Never commit without the plan's commit step; commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Verification commands (run from repo root): `pnpm --filter @libre/browser-extension test`, `... typecheck`, `... lint`, `... build`, `pnpm check:storage`.

---

### Task 1: `core/auto-start.ts` — flag parsing, start plan, connect retry

**Files:**
- Create: `packages/browser-extension/src/core/auto-start.ts`
- Test: `packages/browser-extension/src/core/auto-start.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces (used by Tasks 3–4):
  - `AUTO_START_KEY: "auto_start"`
  - `isAutoStartEnabled(raw: string | null): boolean`
  - `autoStartPlan(i: AutoStartInputs): AutoStartPlan` where `AutoStartInputs = { flagRaw: string | null; hasSeed: boolean; hasChannelState: boolean; createdNew: boolean }` and `AutoStartPlan = { start: boolean; connectPeer: boolean; reason?: string }`
  - `PEER_CONNECT_DELAYS_MS: readonly number[]` (`[2000, 4000, 8000, 16000, 30000]`)
  - `connectWithRetry(connect: () => Promise<void>, opts?): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

```ts
// packages/browser-extension/src/core/auto-start.test.ts
import { describe, it, expect } from "vitest";
import {
  AUTO_START_KEY,
  isAutoStartEnabled,
  autoStartPlan,
  connectWithRetry,
  PEER_CONNECT_DELAYS_MS,
} from "./auto-start";

describe("isAutoStartEnabled", () => {
  it("defaults ON: unset and '1' are enabled, only an explicit '0' disables", () => {
    expect(isAutoStartEnabled(null)).toBe(true);
    expect(isAutoStartEnabled("1")).toBe(true);
    expect(isAutoStartEnabled("0")).toBe(false);
  });

  it("pins the storage key", () => {
    expect(AUTO_START_KEY).toBe("auto_start");
  });
});

describe("autoStartPlan", () => {
  const base = { flagRaw: null, hasSeed: true, hasChannelState: true, createdNew: false };

  it("funded wallet: start AND connect peer", () => {
    expect(autoStartPlan(base)).toEqual({ start: true, connectPeer: true });
  });

  it("flag disabled: does nothing", () => {
    const p = autoStartPlan({ ...base, flagRaw: "0" });
    expect(p.start).toBe(false);
    expect(p.connectPeer).toBe(false);
    expect(p.reason).toBeTruthy();
  });

  it("no seed: does nothing", () => {
    const p = autoStartPlan({ ...base, hasSeed: false });
    expect(p.start).toBe(false);
    expect(p.connectPeer).toBe(false);
  });

  // THE force-close guard: a bare seed that wasn't created here must never boot unattended —
  // an empty ChannelManager that connects the peer force-closes the real channel on
  // channel_reestablish (documented mainnet failure).
  it("seed without channel state, NOT created here: silently skips", () => {
    const p = autoStartPlan({ ...base, hasChannelState: false, createdNew: false });
    expect(p.start).toBe(false);
    expect(p.connectPeer).toBe(false);
    expect(p.reason).toMatch(/restore/i);
  });

  it("brand-new unfunded wallet (created here): starts but never auto-dials", () => {
    expect(autoStartPlan({ ...base, hasChannelState: false, createdNew: true })).toEqual({
      start: true,
      connectPeer: false,
    });
  });
});

describe("connectWithRetry", () => {
  const instant = () => Promise.resolve(); // no real waiting in tests

  it("returns true on first success without sleeping", async () => {
    let calls = 0;
    const ok = await connectWithRetry(
      async () => {
        calls++;
      },
      { sleep: instant }
    );
    expect(ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("retries through the schedule then succeeds", async () => {
    let calls = 0;
    const slept: number[] = [];
    const ok = await connectWithRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("bridge not up yet");
      },
      { delaysMs: [10, 20, 30], sleep: async (ms) => void slept.push(ms) }
    );
    expect(ok).toBe(true);
    expect(calls).toBe(3);
    expect(slept).toEqual([10, 20]); // waited delays[0] and delays[1] between attempts
  });

  it("gives up after exhausting the schedule (delays.length + 1 attempts)", async () => {
    let calls = 0;
    const ok = await connectWithRetry(
      async () => {
        calls++;
        throw new Error("nope");
      },
      { delaysMs: [1, 2], sleep: instant }
    );
    expect(ok).toBe(false);
    expect(calls).toBe(3);
  });

  it("aborts when shouldContinue turns false (node stopped mid-retry)", async () => {
    let calls = 0;
    const ok = await connectWithRetry(
      async () => {
        calls++;
        throw new Error("nope");
      },
      { delaysMs: [1, 2, 3], sleep: instant, shouldContinue: () => calls < 2 }
    );
    expect(ok).toBe(false);
    expect(calls).toBe(2); // third attempt never dialed
  });

  it("reports each failed attempt (1-indexed)", async () => {
    const attempts: number[] = [];
    await connectWithRetry(
      async () => {
        throw new Error("nope");
      },
      { delaysMs: [1], sleep: instant, onAttemptFailed: (n) => void attempts.push(n) }
    );
    expect(attempts).toEqual([1, 2]);
  });

  it("boot schedule is 2s/4s/8s/16s/30s", () => {
    expect([...PEER_CONNECT_DELAYS_MS]).toEqual([2000, 4000, 8000, 16000, 30000]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @libre/browser-extension exec vitest run src/core/auto-start.test.ts`
Expected: FAIL — `Cannot find module './auto-start'` (or equivalent resolve error).

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/browser-extension/src/core/auto-start.ts
// Auto-start decision logic for the offscreen wallet host. Pure and chrome-free so it is
// unit-testable; the host supplies the storage markers and executes the plan.
//
// The critical row: a seed with NO channel state that was NOT created brand-new here must
// NEVER auto-start — an unattended empty ChannelManager that connects the peer replies
// "unknown channel" to channel_reestablish and force-closes the real channel (the documented
// mainnet failure). That case is a silent skip here AND stays a hard error in startNode().

export const AUTO_START_KEY = "auto_start";

// Default ON — a wallet should just run. Only an explicit "0" disables.
export function isAutoStartEnabled(raw: string | null): boolean {
  return raw !== "0";
}

export interface AutoStartInputs {
  flagRaw: string | null; // raw chrome.storage.local value under AUTO_START_KEY
  hasSeed: boolean;
  hasChannelState: boolean; // channel_manager key present
  createdNew: boolean; // wallet_created_new provenance marker
}

export interface AutoStartPlan {
  start: boolean;
  connectPeer: boolean;
  reason?: string; // why we skipped (logged, never thrown)
}

export function autoStartPlan(i: AutoStartInputs): AutoStartPlan {
  if (!isAutoStartEnabled(i.flagRaw)) {
    return { start: false, connectPeer: false, reason: "auto-start is disabled" };
  }
  if (!i.hasSeed) {
    return { start: false, connectPeer: false, reason: "no wallet on this network" };
  }
  if (!i.hasChannelState && !i.createdNew) {
    return {
      start: false,
      connectPeer: false,
      reason: "seed has no channel state and was not created here — restore from backup first",
    };
  }
  // A brand-new unfunded wallet starts but never auto-dials (mirrors the PWA's gating: only a
  // wallet with existing channel state keeps its peer alive automatically).
  return { start: true, connectPeer: i.hasChannelState };
}

// Boot-time peer dial schedule: the bridge may not be reachable the instant the browser
// launches. After one successful connect the SDK's own auto-reconnect owns the link.
export const PEER_CONNECT_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000, 30_000];

export interface ConnectRetryOpts {
  delaysMs?: readonly number[];
  shouldContinue?: () => boolean; // consulted before each attempt (abort when the node stopped)
  sleep?: (ms: number) => Promise<void>;
  onAttemptFailed?: (attempt: number, error: unknown) => void; // attempt is 1-indexed
}

// Try connect() until it succeeds: one immediate attempt, then one per delay (waiting that
// delay first). Returns true on success, false when exhausted or aborted. Never throws.
export async function connectWithRetry(connect: () => Promise<void>, opts: ConnectRetryOpts = {}): Promise<boolean> {
  const delays = opts.delaysMs ?? PEER_CONNECT_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const shouldContinue = opts.shouldContinue ?? (() => true);
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (!shouldContinue()) return false;
    try {
      await connect();
      return true;
    } catch (e) {
      opts.onAttemptFailed?.(attempt + 1, e);
      if (attempt === delays.length) return false;
      await sleep(delays[attempt]);
    }
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @libre/browser-extension exec vitest run src/core/auto-start.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add packages/browser-extension/src/core/auto-start.ts packages/browser-extension/src/core/auto-start.test.ts
git commit -m "feat(extension): auto-start decision logic + boot peer-connect retry (pure, tested)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `ExtensionConfig.peer` + peer-string parse/format helpers

**Files:**
- Modify: `packages/browser-extension/src/core/wallet-config.ts`
- Test: `packages/browser-extension/src/core/wallet-config.test.ts`

**Interfaces:**
- Consumes: existing `parseConfig`/`serializeConfig`/`defaultPeer`.
- Produces (used by Tasks 3–4):
  - `ExtensionConfig.peer?: string` (format `pubkey@host:port`)
  - `parsePeerString(peer: string): { pubkey: string; host: string; port: number }` — throws on malformed input
  - `formatPeerString(pubkey: string, host: string, port: number): string`

- [ ] **Step 1: Write the failing tests (append to the existing file)**

```ts
// append to packages/browser-extension/src/core/wallet-config.test.ts
import { serializeConfig, parsePeerString, formatPeerString, type ExtensionConfig } from "./wallet-config";

describe("ExtensionConfig.peer (persisted last-connected peer)", () => {
  it("round-trips through serialize/parse", () => {
    const cfg: ExtensionConfig = { network: "mainnet", peer: DEFAULT_MAINNET_PEER };
    expect(parseConfig(serializeConfig(cfg)).peer).toBe(DEFAULT_MAINNET_PEER);
  });

  it("is optional: old configs without it parse unchanged (backward compat)", () => {
    const cfg = parseConfig(JSON.stringify({ network: "mainnet", esploraUrl: "https://x/api" }));
    expect(cfg.peer).toBeUndefined();
    expect(cfg.esploraUrl).toBe("https://x/api");
  });

  it("drops a blank peer", () => {
    expect(parseConfig(JSON.stringify({ network: "mainnet", peer: "  " })).peer).toBeUndefined();
  });
});

describe("parsePeerString / formatPeerString", () => {
  it("parses pubkey@host:port", () => {
    const p = parsePeerString(DEFAULT_MAINNET_PEER);
    expect(p.pubkey).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(p.host).toBe("45.33.65.45");
    expect(p.port).toBe(9735);
  });

  it("round-trips with formatPeerString", () => {
    const p = parsePeerString(DEFAULT_MAINNET_PEER);
    expect(formatPeerString(p.pubkey, p.host, p.port)).toBe(DEFAULT_MAINNET_PEER);
  });

  it("rejects malformed input (never dial garbage at boot)", () => {
    expect(() => parsePeerString("")).toThrow();
    expect(() => parsePeerString("nopubkey:9735")).toThrow();
    expect(() => parsePeerString("deadbeef@host:9735")).toThrow(); // pubkey not 66 hex 02/03
    expect(() => parsePeerString(`${"02" + "a".repeat(64)}@:9735`)).toThrow(); // empty host
    expect(() => parsePeerString(`${"02" + "a".repeat(64)}@host:0`)).toThrow(); // bad port
    expect(() => parsePeerString(`${"02" + "a".repeat(64)}@host:99999`)).toThrow();
  });
});
```

Note: `DEFAULT_MAINNET_PEER` and `parseConfig` are already imported at the top of the test file; add `serializeConfig`, `parsePeerString`, `formatPeerString`, `type ExtensionConfig` to that existing import instead of a duplicate import block if the linter complains.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm --filter @libre/browser-extension exec vitest run src/core/wallet-config.test.ts`
Expected: FAIL — `parsePeerString` is not exported.

- [ ] **Step 3: Implement**

In `packages/browser-extension/src/core/wallet-config.ts`:

Add to the interface (after `rapidGossipSyncUrl?: string;`):

```ts
  // Last successfully connected channel peer ("pubkey@host:port"). Saved by the offscreen host
  // on every manual connect; auto-start redials it (funded wallets only).
  peer?: string;
```

Add to `parseConfig`'s returned object (after `rapidGossipSyncUrl: str(c.rapidGossipSyncUrl),`):

```ts
      peer: str(c.peer),
```

Add the helpers (after `defaultPeer`):

```ts
export interface PeerParts {
  pubkey: string;
  host: string;
  port: number;
}

// Parse "pubkey@host:port". Throws a user-facing error on malformed input so boot-time
// auto-connect never dials garbage. (IPv6 literals unsupported — the websockify bridge
// transport doesn't use them.)
export function parsePeerString(peer: string): PeerParts {
  const s = (peer || "").trim();
  const at = s.indexOf("@");
  const colon = s.lastIndexOf(":");
  if (at <= 0 || colon <= at + 1) throw new Error(`Invalid peer (expected pubkey@host:port): "${s}"`);
  const pubkey = s.slice(0, at).toLowerCase();
  const host = s.slice(at + 1, colon);
  const port = Number(s.slice(colon + 1));
  if (!/^0[23][0-9a-f]{64}$/.test(pubkey)) {
    throw new Error("Invalid peer pubkey (expected 66 hex characters starting 02/03).");
  }
  if (!host) throw new Error("Invalid peer host.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid peer port.");
  return { pubkey, host, port };
}

export function formatPeerString(pubkey: string, host: string, port: number): string {
  return `${pubkey}@${host}:${port}`;
}
```

- [ ] **Step 4: Run the full package test suite**

Run: `pnpm --filter @libre/browser-extension test`
Expected: PASS — including the untouched `storage-contract.test.ts` (the `peer` field is additive inside the `ldk_config` JSON; no pinned invariant moves).

- [ ] **Step 5: Commit**

```bash
git add packages/browser-extension/src/core/wallet-config.ts packages/browser-extension/src/core/wallet-config.test.ts
git commit -m "feat(extension): persist last-connected peer in ExtensionConfig (additive) + peer-string helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `WalletHost.autoStart()`, start-in-flight guard, peer persistence

**Files:**
- Modify: `packages/browser-extension/src/offscreen/wallet-host.ts`

**Interfaces:**
- Consumes: Task 1's `AUTO_START_KEY`, `autoStartPlan`, `connectWithRetry`; Task 2's `parsePeerString`, `formatPeerString`, `ExtensionConfig.peer`; existing `chromeKV`.
- Produces (used by Task 4): `WalletHost.autoStart(): Promise<void>` (public, non-throwing).

No new unit tests: the decision/retry/parse logic was tested in Tasks 1–2; what remains is orchestration glue over LDK + chrome, which this package deliberately leaves untested (see `vitest.config.ts` comment). Correctness is verified by typecheck + build + the manual checklist in Task 5.

- [ ] **Step 1: Add imports**

At the top of `wallet-host.ts`, extend the existing `wallet-config` import and add the new modules:

```ts
import {
  parseConfig,
  serializeConfig,
  defaultEsploraUrl,
  defaultBridgeUrl,
  defaultRapidGossipSyncUrl,
  defaultPeer,
  parsePeerString,
  formatPeerString,
  CONFIG_KEY,
  type ExtensionConfig,
} from "../core/wallet-config";
import { AUTO_START_KEY, autoStartPlan, connectWithRetry } from "../core/auto-start";
import { chromeKV } from "../core/chrome-kv";
```

- [ ] **Step 2: Serialize concurrent starts**

Replace the current `startNode` method header and early-return with an in-flight guard, renaming the existing body to `doStartNode`. The current method (see `wallet-host.ts:156-192`) becomes:

```ts
  // Serialize concurrent start calls (autoStart racing a popup Start click must not build two
  // wallets over the same storage).
  private startingPromise?: Promise<{ nodeId: string; network: string }>;

  async startNode(): Promise<{ nodeId: string; network: string }> {
    if (this.startingPromise) return this.startingPromise;
    if (this.wallet && this.wallet.status() === "Running") {
      return this.currentNode();
    }
    this.startingPromise = this.doStartNode().finally(() => {
      this.startingPromise = undefined;
    });
    return this.startingPromise;
  }

  private async doStartNode(): Promise<{ nodeId: string; network: string }> {
    // ... EXACT existing body of startNode() from the readiness checks onward, unchanged:
    // (network/storage/hasSeed/hasChannelState/createdNew reads, the two guard throws,
    //  buildWallet, tracker, try/catch around wallet.start(), applySweepAddress,
    //  syncGossip warm, emit, return this.currentNode())
  }
```

Keep the existing comment block above `startNode` ("Start the node, enforcing the readiness guard…") in place above the new `startNode`.

- [ ] **Step 3: Persist the peer on successful manual connect**

Replace the existing `connectPeer` method (`wallet-host.ts:368-372`) with:

```ts
  async connectPeer(pubkey: string, host: string, port: number): Promise<void> {
    this.requireRunning();
    await this.wallet!.connectPeer(pubkey, host, port);
    await this.savePeer(pubkey, host, port);
    this.emit("state-changed");
  }

  // Remember the last successfully connected peer so auto-start can redial it. Written directly
  // to the network's config JSON (setConfig refuses while the node runs — this is an internal,
  // non-destructive single-field update). Best-effort: a persist failure must not fail the
  // connect that already succeeded.
  private async savePeer(pubkey: string, host: string, port: number): Promise<void> {
    try {
      const network = await this.activeNetwork();
      const storage = this.storageForNetwork(network);
      const cfg = parseConfig(await storage.getItem(CONFIG_KEY));
      cfg.network = network as ExtensionConfig["network"];
      cfg.peer = formatPeerString(pubkey, host, port);
      await storage.setItem(CONFIG_KEY, serializeConfig(cfg));
    } catch (e) {
      console.warn("[Peer] could not persist last-connected peer:", (e as Error)?.message || e);
    }
  }
```

- [ ] **Step 4: Add `autoStart()`**

Add after `startNode`/`doStartNode`:

```ts
  // Boot-time auto-start: called once when the offscreen document loads. NEVER throws — a
  // failed or skipped auto-start leaves the host stopped and the popup's manual Start working.
  // The plan mirrors the PWA's assessStartReadiness: a stateless non-created-here seed is a
  // silent skip here AND still a hard error in startNode() (two layers against the
  // empty-node-force-closes-the-channel failure).
  async autoStart(): Promise<void> {
    try {
      const network = await this.activeNetwork();
      const storage = this.storageForNetwork(network);
      const plan = autoStartPlan({
        flagRaw: await chromeKV.get(AUTO_START_KEY),
        hasSeed: !!(await storage.getItem(SEED_KEY)),
        hasChannelState: !!(await storage.getItem(CHANNEL_MANAGER_KEY)),
        createdNew: !!(await storage.getItem(CREATED_NEW_KEY)),
      });
      if (!plan.start) {
        console.log(`[AutoStart] skipped: ${plan.reason}`);
        return;
      }
      await this.startNode();
      if (!plan.connectPeer) return;

      const cfg = await this.getConfig();
      const peerStr = cfg.peer || defaultPeer(network);
      if (!peerStr) {
        console.warn("[AutoStart] no saved or default peer for this network — skipping peer connect");
        return;
      }
      const { pubkey, host, port } = parsePeerString(peerStr);
      const wallet = this.wallet; // abort the retry loop if stop()/restore swaps the instance
      const connected = await connectWithRetry(
        async () => {
          await wallet!.connectPeer(pubkey, host, port);
        },
        {
          shouldContinue: () => this.wallet === wallet && !!wallet && wallet.status() === "Running",
          onAttemptFailed: (n, e) =>
            console.warn(`[AutoStart] peer connect attempt ${n} failed:`, (e as Error)?.message || e),
        }
      );
      if (connected) {
        this.emit("state-changed");
        console.log("[AutoStart] node running, peer connected");
      } else {
        console.warn("[AutoStart] peer connect gave up — use Connect peer in the popup");
      }
    } catch (e) {
      console.warn("[AutoStart] failed:", (e as Error)?.message || e);
    }
  }
```

Note: the retry dials `wallet.connectPeer` (the SDK) directly, not `this.connectPeer`, so a boot redial doesn't re-persist the peer or throw `requireRunning` — and once one attempt succeeds, the SDK's own auto-reconnect owns the link.

- [ ] **Step 5: Typecheck and full test suite**

Run: `pnpm --filter @libre/browser-extension typecheck && pnpm --filter @libre/browser-extension test`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/browser-extension/src/offscreen/wallet-host.ts
git commit -m "feat(extension): WalletHost.autoStart() with readiness plan, start serialization, peer persistence

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Triggers + toggle UI + peer pre-fill

**Files:**
- Modify: `packages/browser-extension/src/offscreen/offscreen.ts`
- Modify: `packages/browser-extension/src/background.ts`
- Modify: `packages/browser-extension/src/popup/popup.html`
- Modify: `packages/browser-extension/src/popup/popup.ts`
- Modify: `packages/browser-extension/src/options/options.ts`

**Interfaces:**
- Consumes: Task 3's `host.autoStart()`; Task 1's `AUTO_START_KEY`, `isAutoStartEnabled`; Task 2's `parsePeerString`; existing `ensureOffscreen`, `chromeKV`, `command`.
- Produces: `WALLET_COMMAND` commands `getAutoStart` (→ `boolean`) and `setAutoStart` (`{ enabled: boolean }`), handled in the background like `getAutoDownload`/`setAutoDownload`.

- [ ] **Step 1: Kick auto-start from the offscreen boot**

At the end of `packages/browser-extension/src/offscreen/offscreen.ts` (after the `chrome.runtime.onMessage.addListener(...)` block, so the RPC surface is live first):

```ts
// Auto-start: the node comes up whenever this document is created — browser launch (the
// background's onStartup → ensureOffscreen), an extension install/update, or a lazy creation
// for an incoming WebLN request. autoStart() is non-throwing and enforces the readiness plan.
void host.autoStart();
```

- [ ] **Step 2: Background lifecycle triggers + toggle commands**

In `packages/browser-extension/src/background.ts`, add to the imports:

```ts
import { AUTO_START_KEY, isAutoStartEnabled } from "./core/auto-start";
```

After the `ensureOffscreen`/`callOffscreen` definitions (below `background.ts:57`), add:

```ts
// ---- Auto-start ----
//
// Bring the wallet up on browser launch and extension install/update. The offscreen document's
// boot runs host.autoStart() (which reads the persisted flag and readiness markers), so the only
// job here is making sure the document exists.
chrome.runtime.onStartup.addListener(() => {
  void ensureOffscreen().catch((e: any) => console.warn("[AutoStart] ensureOffscreen failed:", e?.message || e));
});
chrome.runtime.onInstalled.addListener(() => {
  void ensureOffscreen().catch((e: any) => console.warn("[AutoStart] ensureOffscreen failed:", e?.message || e));
});
```

In the `WALLET_COMMAND` router, after the `setAutoDownload` branch (`background.ts:373-374`), add:

```ts
      } else if (msg.command === "getAutoStart") {
        reply(chromeKV.get(AUTO_START_KEY).then(isAutoStartEnabled));
      } else if (msg.command === "setAutoStart") {
        reply(chromeKV.set(AUTO_START_KEY, msg.params?.enabled ? "1" : "0"));
```

- [ ] **Step 3: Popup toggle**

In `packages/browser-extension/src/popup/popup.html`, directly after the Start/Stop row (`<div class="row"><button id="start">…</div>`), add:

```html
      <label style="display:flex;align-items:center;gap:8px;margin-top:8px;font-weight:400">
        <input type="checkbox" id="auto-start" style="width:auto" />
        Auto-start node when the browser opens
      </label>
```

In `packages/browser-extension/src/popup/popup.ts`, next to `refreshAutoDownload` (`popup.ts:203-216`), add:

```ts
// Auto-start toggle: persisted in the background (chrome.storage.local), default ON.
async function refreshAutoStart() {
  const on = await command<boolean>("getAutoStart").catch(() => true);
  ($("auto-start") as HTMLInputElement).checked = !!on;
}
$("auto-start").addEventListener("change", async (e) => {
  const enabled = (e.target as HTMLInputElement).checked;
  await command("setAutoStart", { enabled }).catch((err) => setMsg("msg", err.message, "err"));
  setMsg("msg", enabled ? "Auto-start on — the node starts with the browser." : "Auto-start off.", "ok");
});
```

And inside `refresh()`, in the `if (hasWallet) {` block (NOT gated on `running` — the toggle matters most when the node is stopped), add:

```ts
      void refreshAutoStart();
```

- [ ] **Step 4: Pre-fill popup peer fields from the saved peer**

In `popup.ts`, add to the imports:

```ts
import { defaultPeer, parsePeerString } from "../core/wallet-config";
```

Add near the bottom (before `onWalletEvent(() => refresh());`):

```ts
// Pre-fill the connect-peer fields from the saved (last-connected) peer, falling back to the
// network default. Only fills blanks — never clobbers what the user typed. Cosmetic: failures
// are ignored.
async function prefillPeer() {
  try {
    const c = await command<any>("getConfig");
    const peerStr = c.peer || defaultPeer(c.network || "mainnet");
    if (!peerStr) return;
    const { pubkey, host, port } = parsePeerString(peerStr);
    const pk = $("peer-pubkey") as HTMLInputElement;
    const h = $("peer-host") as HTMLInputElement;
    const p = $("peer-port") as HTMLInputElement;
    if (!pk.value.trim()) pk.value = pubkey;
    if (!h.value.trim()) h.value = host;
    if (!p.value.trim() || p.value === "9735") p.value = String(port);
  } catch {
    /* pre-fill is cosmetic */
  }
}
void prefillPeer();
```

- [ ] **Step 5: Prefer the saved peer in the options page too**

In `packages/browser-extension/src/options/options.ts`, replace the `prefillPeer` function (`options.ts:36-48`) with one that prefers the saved peer and reuses the tested parser:

```ts
// Pre-fill the connect-peer fields with the saved (last-connected) peer, falling back to the
// network's default. Only fills blanks, so it never clobbers what the user typed. Nothing
// auto-connects from here — they still click Connect peer.
function prefillPeer(network: string, savedPeer?: string) {
  const peer = savedPeer || defaultPeer(network);
  if (!peer) return;
  let parts;
  try {
    parts = parsePeerString(peer);
  } catch {
    return; // a corrupt saved peer just means no pre-fill
  }
  const pk = $<HTMLInputElement>("peer-pubkey");
  const host = $<HTMLInputElement>("peer-host");
  const port = $<HTMLInputElement>("peer-port");
  if (!pk.value.trim()) pk.value = parts.pubkey;
  if (!host.value.trim()) host.value = parts.host;
  if (!port.value.trim() || port.value === "9735") port.value = String(parts.port);
}
```

Update its call site in `loadConfig()` (`options.ts:24`) from `prefillPeer(network);` to:

```ts
    prefillPeer(network, c.peer);
```

And add `parsePeerString` to the options import from `../core/wallet-config`:

```ts
import { defaultBridgeUrl, defaultRapidGossipSyncUrl, defaultPeer, parsePeerString } from "../core/wallet-config";
```

- [ ] **Step 6: Build, typecheck, lint, test**

Run: `pnpm --filter @libre/browser-extension build && pnpm --filter @libre/browser-extension typecheck && pnpm --filter @libre/browser-extension lint && pnpm --filter @libre/browser-extension test`
Expected: all PASS (lint: 0 errors; warnings are pre-existing backlog only).

- [ ] **Step 7: Commit**

```bash
git add packages/browser-extension/src/offscreen/offscreen.ts packages/browser-extension/src/background.ts packages/browser-extension/src/popup/popup.html packages/browser-extension/src/popup/popup.ts packages/browser-extension/src/options/options.ts
git commit -m "feat(extension): auto-start triggers (onStartup/onInstalled/offscreen boot), popup toggle, saved-peer pre-fill

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Repo-level verification, docs, manual checklist

**Files:**
- Modify: `/Users/chad-mini/Vibe/libre-listener-wallet-monorepo/CLAUDE.md` (browser-extension bullet)

**Interfaces:**
- Consumes: everything above.
- Produces: green repo-wide checks + updated docs.

- [ ] **Step 1: Repo-wide guards**

Run: `pnpm check:storage`
Expected: PASS with zero changes to any `storage-contract.test.ts` (the new `peer` field and `auto_start` key are additive).

Run: `pnpm --filter @libre/browser-extension test && pnpm --filter @libre/browser-extension build`
Expected: PASS.

- [ ] **Step 2: Update CLAUDE.md**

In the `packages/browser-extension` bullet of the repo `CLAUDE.md`, find the sentence fragment `nothing auto-connects (explicit Connect Peer)` and replace it with:

```
**auto-start** (default ON, popup toggle, `auto_start` in chrome.storage.local): the offscreen boot runs `WalletHost.autoStart()` — plan logic in `core/auto-start.ts` mirrors the PWA readiness guard (stateless non-created-here seed silently skips; brand-new wallet starts but never auto-dials; funded wallet starts AND redials the saved peer `ExtensionConfig.peer` with a 2s→30s backoff, then the SDK's auto-reconnect owns the link); background `onStartup`/`onInstalled` just `ensureOffscreen()`
```

- [ ] **Step 3: Manual verification checklist (requires the loaded extension; report results, don't skip)**

1. Rebuild and reload the extension (`chrome://extensions` → reload, or re-load unpacked from `dist/`). Reload alone fires `onInstalled` → the node should auto-start with the popup closed: open the offscreen console (chrome://extensions → service worker / offscreen inspect) and confirm `[AutoStart]` lines.
2. With a funded wallet: quit and relaunch the browser → open the popup → node running, peer count ≥ 1, without clicking anything.
3. Untick "Auto-start node when the browser opens" → relaunch browser → node stays stopped; manual Start still works. Re-tick.
4. Auto-backup continuity (user requirement): with auto-backup ON, relaunch the browser, receive or send a payment (or connect the peer to trigger a state change), and confirm the rolling `libre-wallet-backup-<network>-auto.json` file's modified time updates with the popup never opened.
5. Popup peer fields arrive pre-filled after a successful manual connect (from the saved peer, not just the default).

- [ ] **Step 4: Commit docs**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md — extension auto-start (offscreen boot, readiness plan, saved peer)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review (done at plan-writing time)

- **Spec coverage:** flag + default-on toggle (Tasks 1, 4), persisted peer + pre-fill (Tasks 2, 4), pure plan with the five-row table (Task 1), non-throwing `autoStart()` with retry schedule + in-flight start guard (Task 3), offscreen/onStartup/onInstalled triggers (Task 4), auto-backup continuity pinned by manual check (Task 5 — spec calls for the flag round-trip test, which exists already for `getAutoDownload`; the new behavior is exercised manually since chrome glue is untested by convention). Storage contract untouched (Task 5 Step 1).
- **Placeholder scan:** the one intentional ellipsis is Task 3 Step 2's `doStartNode` body, which explicitly says "EXACT existing body … unchanged" with its current line range — a move, not new code.
- **Type consistency:** `autoStartPlan`/`AutoStartInputs`/`AutoStartPlan`/`connectWithRetry`/`PEER_CONNECT_DELAYS_MS` (Task 1) match their uses in Task 3; `parsePeerString`/`formatPeerString`/`peer?: string` (Task 2) match Tasks 3–4; `getAutoStart`→`boolean` matches the popup's `command<boolean>`.
