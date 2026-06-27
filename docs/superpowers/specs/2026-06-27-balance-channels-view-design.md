# Wallet Balance & Channels View — Design

- **Date:** 2026-06-27
- **Status:** Approved (pending spec review)
- **Scope:** SDK accessors (`getChannels`/`getBalance` on `LibreListenerWallet`) + example-app balance/channel-list UI.

## 1. Background / Why

The wallet can now be funded (the LSPS2 onboarding server opens channels with pushed sats), but the example app has **no way to see balance or channels** — the status box shows only Node ID and Peers. The SDK exposes `getChannelManager()` (raw LDK) but no clean balance/channels accessor. So a user can't tell whether they're funded, how much they can spend/receive, or whether a channel is active (the `active:false` situation seen during funding). This adds a read-only balance + channel-list view, updated live.

## 2. Goals / Non-Goals

**Goals**
- Public SDK methods returning plain-JS channel info + aggregated balance.
- App UI showing spendable/receivable totals and a per-channel list with active/ready status.
- Live updates (events + a light poll) without manual refresh.

**Non-Goals**
- Payment history, fiat conversion, opening/closing channels from the UI (later).
- Any change to channel/keysend/LSP logic.

## 3. SDK accessors (`packages/libre-listener-wallet/src/index.ts`)

`ChannelInfo` (exported type):
```ts
export interface ChannelInfo {
  channelId: string;            // hex of get_channel_id().get_a()
  counterpartyNodeId: string;   // hex of get_counterparty().get_node_id()
  capacitySat: number;          // get_channel_value_satoshis() (bigint → Number)
  outboundSendableSat: number;  // get_outbound_capacity_msat() / 1000 (what we can send now)
  inboundSat: number;           // get_inbound_capacity_msat() / 1000 (what we can receive now)
  isUsable: boolean;            // get_is_usable() (ready + peer connected)
  isChannelReady: boolean;      // get_is_channel_ready() (funding confirmed/locked)
}
```
> LDK 0.1.0 `ChannelDetails` has **no** `get_balance_msat`, so there's no exact local balance; outbound-sendable + inbound capacity are the meaningful figures. msat getters return `bigint` — convert as `Number(x / 1000n)`.

- `getChannels(): ChannelInfo[]` — if not running / no channel manager, return `[]`. Else map each `channelManager.list_channels()` entry via `mapChannelDetails`.
- `getBalance(): { spendableSat: number; receivableSat: number }` = `sumBalance(getChannels())`. Zeros when not running.
- `sumBalance(channels: ChannelInfo[]): { spendableSat, receivableSat }` — pure helper: `spendableSat` = Σ `outboundSendableSat` over **usable** channels; `receivableSat` = Σ `inboundSat` over usable channels. Exported so it's unit-testable directly.
- `mapChannelDetails(cd): ChannelInfo` — pure helper mapping one LDK `ChannelDetails` (via its getters: `get_channel_id`, `get_counterparty().get_node_id()`, `get_channel_value_satoshis`, `get_balance_msat`, `get_outbound_capacity_msat`, `get_inbound_capacity_msat`, `get_is_usable`, `get_is_channel_ready`) to `ChannelInfo`. Bytes→hex via `bytesToHex`. Exported so it's unit-testable with a stub.

No new dependencies; `ChannelDetails` is already imported.

## 4. App UI (`packages/example-app`)

In `index.html`, add a **Wallet** block under the existing status box. The two headline facts (per the user) are **is the channel connected** and **what's the balance**:
- **Balance:** `Spendable: <n> sats` and `Receivable: <n> sats`.
- **Channels (<count>):** a container (`#channels-list`), one row per channel: short channel id (first 8 hex…), capacity, `send <outboundSendableSat> / recv <inboundSat>`, and a prominent status badge — **green "active"** if `isUsable` (ready **and** peer connected), **amber "ready"** if `isChannelReady && !isUsable` (confirmed but peer not connected), **grey "pending"** otherwise. Empty → "No channels yet."

In `main.ts`, add `refreshWalletView()`:
- Reads `wallet.getBalance()` + `wallet.getChannels()`, writes the balance spans and rebuilds `#channels-list`. No-op (renders zeros / "No channels yet") when `wallet` is null / not running.
- **Triggers:** after node start; inside the existing `onStateChanged` callback; inside the existing LDK `addEventListener` handler (so `ChannelReady`/payment events refresh it); and a **~5s `setInterval`** while running.
- The interval is started on node start and **cleared on stop** (store the handle; clear alongside the existing stop cleanup). Cheap in-memory reads, no network.

## 5. Data Flow

start → register onStateChanged + event listener (existing) → start 5s poll → `refreshWalletView()`. Any of {poll tick, state-changed, LDK event} → `refreshWalletView()` → reads SDK → re-renders. stop → clear interval → render empty.

## 6. Error Handling

`getChannels`/`getBalance` guard on `isRunning`/`channelManager` and return empty/zero rather than throwing. `refreshWalletView` wraps its read in try/catch and logs via the app logger on failure (no crash of the poll loop).

## 7. Testing (TDD)

- **SDK unit (`index.ts` accessors):**
  - `mapChannelDetails` maps a stub `ChannelDetails` (object with the getter methods returning known values) to the exact `ChannelInfo` (msat→sat division, hex conversion).
  - `sumBalance` over an array of `ChannelInfo` sums `outboundSendableSat`/`inboundSat` for **usable** channels and excludes unusable ones (pure — direct array input).
  - `getChannels()`/`getBalance()` return `[]` / `{spendableSat:0,receivableSat:0}` when the node isn't running.
  - No live channel required (mapper + aggregation are pure; the not-running paths need no LDK).
- **App:** manual verification — fund via the LSPS2 server, confirm the balance + an "active" channel row appear and update within ~5s.

## 8. Scope summary

**In:** `ChannelInfo`, `getChannels`, `getBalance`, `mapChannelDetails` (SDK); balance + channel-list UI with event + 5s-poll refresh (app).
**Out:** payment history, fiat, channel open/close UI.
