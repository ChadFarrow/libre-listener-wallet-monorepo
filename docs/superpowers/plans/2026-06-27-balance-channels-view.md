# Wallet Balance & Channels View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show whether each channel is connected/active and the wallet's spendable/receivable balance — via SDK accessors + a live-updating app view.

**Architecture:** SDK gains pure helpers (`mapChannelDetails`, `sumBalance`) and public `getChannels()`/`getBalance()` on `LibreListenerWallet`, reading LDK `channelManager.list_channels()`. The example app renders a balance + channel-list block, refreshed on node start, `onStateChanged`, LDK events, and a 5s poll (cleared on stop).

**Tech Stack:** TypeScript, LDK WASM (`lightningdevkit` 0.1.0), Vitest, pnpm + Turborepo.

## Global Constraints

- pnpm@10.10.0; SDK stays platform-free; vitest jsdom (wallet) / jsdom (app); TDD; files kebab-case / types PascalCase / functions camelCase.
- LDK 0.1.0 `ChannelDetails` getters (verified): `get_channel_id().get_a():Uint8Array`, `get_counterparty().get_node_id():Uint8Array`, `get_channel_value_satoshis():bigint`, `get_outbound_capacity_msat():bigint`, `get_inbound_capacity_msat():bigint`, `get_is_usable():boolean`, `get_is_channel_ready():boolean`. There is **no** `get_balance_msat`. msat→sat via `Number(x / 1000n)`.
- Headline facts to surface: channel **connected/active** (isUsable) and **balance** (spendable/receivable).
- Never commit to `master`; feature branch; no push without approval.

---

## File Structure

- `packages/libre-listener-wallet/src/index.ts` — add `ChannelInfo`, `mapChannelDetails`, `sumBalance`, `getChannels()`, `getBalance()`.
- `packages/libre-listener-wallet/src/tests/unit/channels.test.ts` — create; unit tests for the pure helpers + not-running paths.
- `packages/example-app/index.html` — add the Wallet balance/channels block.
- `packages/example-app/src/main.ts` — add `refreshWalletView()` + wiring (start/stop/onStateChanged/event/5s poll).

---

## Task 0: Feature branch

- [ ] **Step 1: Branch**

```bash
cd /Users/chad-mini/Vibe/libre-listener-wallet-monorepo
git checkout -b feat/balance-channels-view
```

---

## Task 1: SDK — ChannelInfo, mappers, getChannels/getBalance

**Files:**
- Modify: `packages/libre-listener-wallet/src/index.ts`
- Test: `packages/libre-listener-wallet/src/tests/unit/channels.test.ts` (create)

**Interfaces:**
- Produces:
  - `interface ChannelInfo { channelId: string; counterpartyNodeId: string; capacitySat: number; outboundSendableSat: number; inboundSat: number; isUsable: boolean; isChannelReady: boolean; }`
  - `mapChannelDetails(cd: ChannelDetails): ChannelInfo` (exported)
  - `sumBalance(channels: ChannelInfo[]): { spendableSat: number; receivableSat: number }` (exported)
  - `LibreListenerWallet.getChannels(): ChannelInfo[]`
  - `LibreListenerWallet.getBalance(): { spendableSat: number; receivableSat: number }`

- [ ] **Step 1: Write the failing test**

Create `packages/libre-listener-wallet/src/tests/unit/channels.test.ts`:
```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { mapChannelDetails, sumBalance, ChannelInfo } from "../../index";

// Minimal stub matching the LDK ChannelDetails getters mapChannelDetails uses.
function stubCd(over: Partial<{
  id: number[]; node: number[]; capacity: bigint; outMsat: bigint; inMsat: bigint; usable: boolean; ready: boolean;
}> = {}) {
  const o = { id: [0xab, 0xcd], node: [0x02, 0x11], capacity: 1_000_000n, outMsat: 200_000_000n, inMsat: 800_000_000n, usable: true, ready: true, ...over };
  return {
    get_channel_id: () => ({ get_a: () => new Uint8Array(o.id) }),
    get_counterparty: () => ({ get_node_id: () => new Uint8Array(o.node) }),
    get_channel_value_satoshis: () => o.capacity,
    get_outbound_capacity_msat: () => o.outMsat,
    get_inbound_capacity_msat: () => o.inMsat,
    get_is_usable: () => o.usable,
    get_is_channel_ready: () => o.ready,
  } as any;
}

describe("mapChannelDetails", () => {
  it("maps an LDK ChannelDetails to ChannelInfo (msat→sat, bytes→hex)", () => {
    const info = mapChannelDetails(stubCd());
    expect(info).toEqual<ChannelInfo>({
      channelId: "abcd",
      counterpartyNodeId: "0211",
      capacitySat: 1_000_000,
      outboundSendableSat: 200_000,
      inboundSat: 800_000,
      isUsable: true,
      isChannelReady: true,
    });
  });
});

describe("sumBalance", () => {
  const ch = (over: Partial<ChannelInfo>): ChannelInfo => ({
    channelId: "x", counterpartyNodeId: "y", capacitySat: 0, outboundSendableSat: 0, inboundSat: 0, isUsable: true, isChannelReady: true, ...over,
  });
  it("sums spendable/receivable over usable channels only", () => {
    const r = sumBalance([
      ch({ outboundSendableSat: 200_000, inboundSat: 800_000, isUsable: true }),
      ch({ outboundSendableSat: 50_000, inboundSat: 10_000, isUsable: false }), // excluded
    ]);
    expect(r).toEqual({ spendableSat: 200_000, receivableSat: 800_000 });
  });
  it("zero for empty / no usable channels", () => {
    expect(sumBalance([])).toEqual({ spendableSat: 0, receivableSat: 0 });
    expect(sumBalance([ch({ outboundSendableSat: 5, isUsable: false })])).toEqual({ spendableSat: 0, receivableSat: 0 });
  });
});
```

- [ ] **Step 2: Run → fail**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/channels.test.ts`
Expected: FAIL — `mapChannelDetails`/`sumBalance` not exported.

- [ ] **Step 3: Implement in `index.ts`**

Add near the other exported helpers/types (top-level, not inside the class). `bytesToHex` is already imported from `./storage-cache`; `ChannelDetails` is already imported.
```ts
export interface ChannelInfo {
  channelId: string;
  counterpartyNodeId: string;
  capacitySat: number;
  outboundSendableSat: number;
  inboundSat: number;
  isUsable: boolean;
  isChannelReady: boolean;
}

// Map one LDK ChannelDetails to a plain ChannelInfo. msat getters are bigint.
export function mapChannelDetails(cd: ChannelDetails): ChannelInfo {
  return {
    channelId: bytesToHex(cd.get_channel_id().get_a()),
    counterpartyNodeId: bytesToHex(cd.get_counterparty().get_node_id()),
    capacitySat: Number(cd.get_channel_value_satoshis()),
    outboundSendableSat: Number(cd.get_outbound_capacity_msat() / 1000n),
    inboundSat: Number(cd.get_inbound_capacity_msat() / 1000n),
    isUsable: cd.get_is_usable(),
    isChannelReady: cd.get_is_channel_ready(),
  };
}

// Aggregate spendable/receivable over USABLE channels only.
export function sumBalance(channels: ChannelInfo[]): { spendableSat: number; receivableSat: number } {
  const usable = channels.filter((c) => c.isUsable);
  return {
    spendableSat: usable.reduce((s, c) => s + c.outboundSendableSat, 0),
    receivableSat: usable.reduce((s, c) => s + c.inboundSat, 0),
  };
}
```
Add these public methods to the `LibreListenerWallet` class (near `getChannelManager()`):
```ts
  getChannels(): ChannelInfo[] {
    if (!this.isRunning || !this.channelManager) return [];
    return this.channelManager.list_channels().map(mapChannelDetails);
  }

  getBalance(): { spendableSat: number; receivableSat: number } {
    return sumBalance(this.getChannels());
  }
```

- [ ] **Step 4: Run → pass**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/channels.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Full SDK suite (no regressions)**

Run: `pnpm --filter @libre/listener-wallet test`
Expected: PASS.

- [ ] **Step 6: Build (refresh dist for the app)**

Run: `pnpm --filter @libre/listener-wallet build`
Expected: success.

- [ ] **Step 7: Commit**

```bash
git add packages/libre-listener-wallet/src/index.ts packages/libre-listener-wallet/src/tests/unit/channels.test.ts
git commit -m "feat(sdk): getChannels/getBalance + ChannelInfo (channel status + balance)"
```

---

## Task 2: App — balance/channels view + live refresh

**Files:**
- Modify: `packages/example-app/index.html`
- Modify: `packages/example-app/src/main.ts`

**Interfaces:**
- Consumes: `wallet.getBalance()`, `wallet.getChannels()` (Task 1).
- Produces: `refreshWalletView()`, DOM ids `balance-spendable`, `balance-receivable`, `channels-count`, `channels-list`.

- [ ] **Step 1: Add the Wallet block to the status box**

In `index.html`, inside the existing `<div class="status-box">` (right after the "Peers Connected" status-line), add:
```html
            <div class="status-line">
              <span class="label">Spendable:</span>
              <span id="balance-spendable" class="value">0 sats</span>
            </div>
            <div class="status-line">
              <span class="label">Receivable:</span>
              <span id="balance-receivable" class="value">0 sats</span>
            </div>
            <div class="status-line">
              <span class="label">Channels:</span>
              <span id="channels-count" class="value">0</span>
            </div>
            <div id="channels-list" class="help-text">No channels yet</div>
```

- [ ] **Step 2: Add DOM refs + the timer var in `main.ts`**

Near the other DOM refs (e.g., after `peersCountVal`):
```ts
const balanceSpendableEl = document.getElementById("balance-spendable") as HTMLSpanElement;
const balanceReceivableEl = document.getElementById("balance-receivable") as HTMLSpanElement;
const channelsCountEl = document.getElementById("channels-count") as HTMLSpanElement;
const channelsListEl = document.getElementById("channels-list") as HTMLDivElement;
```
Near the other module state (e.g., by `let isNodeRunning`):
```ts
let walletViewTimer: any = null;
```

- [ ] **Step 3: Add `refreshWalletView()`**

Add (e.g., above the start handler):
```ts
// Renders balance + channel list with connected/active status. Safe to call any time.
function refreshWalletView(): void {
  try {
    if (!wallet || !isNodeRunning) {
      balanceSpendableEl.textContent = "0 sats";
      balanceReceivableEl.textContent = "0 sats";
      channelsCountEl.textContent = "0";
      channelsListEl.textContent = "No channels yet";
      return;
    }
    const bal = wallet.getBalance();
    const chans = wallet.getChannels();
    balanceSpendableEl.textContent = `${bal.spendableSat} sats`;
    balanceReceivableEl.textContent = `${bal.receivableSat} sats`;
    channelsCountEl.textContent = String(chans.length);
    if (chans.length === 0) {
      channelsListEl.textContent = "No channels yet";
      return;
    }
    channelsListEl.innerHTML = chans
      .map((c) => {
        const badge = c.isUsable
          ? '<span style="color:#22c55e">● active</span>'
          : c.isChannelReady
          ? '<span style="color:#f59e0b">● ready (peer offline)</span>'
          : '<span style="color:#9ca3af">● pending</span>';
        return `<div class="status-line"><span class="value">${c.channelId.slice(0, 8)}… ${badge}</span>` +
          `<span class="value">cap ${c.capacitySat} · send ${c.outboundSendableSat} / recv ${c.inboundSat}</span></div>`;
      })
      .join("");
  } catch (e) {
    appendLog(`[WARN] refreshWalletView failed: ${e instanceof Error ? e.message : e}`, "warn");
  }
}
```
(Channel ids are wallet-generated hex; numbers are numeric — safe for `innerHTML`.)

- [ ] **Step 4: Wire refresh into start / stateChanged / events / 5s poll**

In the node-start success path (where `isNodeRunning = true` and `onStateChanged` is registered), after the existing setup add:
```ts
    refreshWalletView();
    if (walletViewTimer) clearInterval(walletViewTimer);
    walletViewTimer = setInterval(refreshWalletView, 5000);
```
Inside the existing `onWalletStateChanged()` function, add a call at the end:
```ts
  refreshWalletView();
```
Inside the existing `wallet.addEventListener((event) => { ... })` handler, add at the end of the callback:
```ts
    refreshWalletView();
```

- [ ] **Step 5: Clear the poll + reset the view on stop**

In the stop handler (where `isNodeRunning = false` and UI is reset), add:
```ts
    if (walletViewTimer) {
      clearInterval(walletViewTimer);
      walletViewTimer = null;
    }
    refreshWalletView(); // renders zeros / "No channels yet"
```

- [ ] **Step 6: Typecheck + build**

Run: `pnpm --filter @libre/example-app exec tsc --noEmit` then `pnpm --filter @libre/example-app build`
Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
git add packages/example-app/index.html packages/example-app/src/main.ts
git commit -m "feat(app): wallet balance + channel-status view (live, 5s poll)"
```

---

## Task 3: Full suite + manual verification

- [ ] **Step 1: Full suite**

Run: `pnpm test`
Expected: all packages PASS (wallet incl. new channels tests).

- [ ] **Step 2: Manual verification**

1. `docker compose up -d`; start the LSPS2 server (its README); `pnpm --filter @libre/example-app dev`.
2. App on regtest → Start → Connect Peer → **Request Invoice** (funds a channel).
3. Within ~5s the **Channels** count shows ≥1, the row shows an **active** badge once the peer is connected + channel ready, and **Spendable** shows ~200000 sats.
4. Stop the node → balance resets to 0 / "No channels yet".

- [ ] **Step 3: Confirm with the human, then merge only on approval** (via `superpowers:finishing-a-development-branch`).

---

## Notes for the implementer
- Locate insertion points by symbol: `peersCountVal`, `onWalletStateChanged`, `wallet.addEventListener`, the start-success block, the stop handler.
- Don't free the `ChannelDetails` objects from `list_channels()` — LDK-JS cleans up via FinalizationRegistry (matches existing code).
- Keep the SDK platform-free (no `window`/`document`).
