# Channel-gone UX: single-channel lifecycle, close records, sweep visibility

**Date:** 2026-07-11
**Status:** Approved (design), pending implementation plan
**Packages:** `@libre/listener-wallet` (SDK), `@libre/wallet-pwa`

## Problem

When a user's channel disappears — force-close (either side), cooperative close, or an
expired LSP lease — the PWA today behaves as if the wallet were brand new:

1. The status pill shows the first-run copy "No channel yet — get one to receive";
   there is no distinction between "never had a channel" and "your channel closed".
2. The full-screen onboarding overlay re-triggers ("Get your first channel.") because
   `screens/onboarding.ts` re-evaluates on every controller event with no `done` guard
   and the flow keys on `channels === 0`.
3. Sweep/recovery is invisible. With a recovery address set, funds sweep with only
   console logs. With none set, the SDK logs once and silently ReplayEvents forever —
   the user is never prompted to set a recovery address, which is exactly when they
   need it. Recovering funds show as balance 0 with no explanation.
4. The close never appears in transaction history.
5. The SDK does not handle `Event_ChannelClosed` at all — the UI only notices the
   channel count drop.

This shipped-app gap was exposed live on 2026-07-11 by a real mainnet force-close
(fallen-behind state → lnd force-closed → user saw only generic errors and first-run
copy).

**Product framing (from the user):** this app's model is ONE channel per user. The
channel is not a list to manage; it is a lifecycle the wallet is always in exactly one
phase of. That lifecycle must be baked into the app.

## Scope

In scope:
- Distinguish "closed" from "never had" everywhere (pill, onboarding, channels screen).
- Sweep/recovery visibility: prompt to set a recovery address when needed; show
  recovering → recovered status.
- Channel closes and sweeps as permanent rows in transaction history.

Out of scope (deferred):
- LSP lease-expiry heads-up (proactive warning before a lease ends).
- A dedicated per-close detail screen (mempool links, reason taxonomy UI).
- Any change to when/how funds are actually swept (observability only).

## Design

### 1. SDK: close records — new `close-log.ts`

- Import `Event_ChannelClosed` and the `ClosureReason_*` classes; add an `instanceof`
  branch in `handle_event` (`index.ts`) — same minify-safe rule as every other branch;
  extend `tests/unit/event-dispatch-minify-safe.test.ts`.
- On close, persist a `ChannelCloseRecord`:
  `{ channelId, counterpartyNodeId, capacitySat?, reason, closedAt }`.
  `reason` maps `ClosureReason_*` to stable strings: `counterparty-force-closed`,
  `we-force-closed`, `cooperative`, `outdated-manager`, `other`.
- Storage: one **non-critical** `close_<channelId>` key per record (the exact
  `payment-log.ts` pattern): rehydrated at `start()` via `storage.keys()`, unbounded,
  **never in the backup**, no storage-contract changes.
- New getter `getChannelCloses(): ChannelCloseRecord[]` — like `getPayments()`, must
  work with the node stopped (fresh reader over storage).

### 2. SDK: sweep status becomes visible

The sweep pipeline (`handleSpendableOutputs`, `pendingSweeps`, `SWEEP_PENDING_KEY`,
`broadcastPendingSweeps`) keeps working exactly as today; it stops being log-only.

- New `getSweepStatus(): { needsAddress: boolean, pendingSat: number,
  lastSweep?: { txid: string, sat: number, at: number } }`.
- The ReplayEvent no-address path sets `needsAddress: true` and fires
  `notifyStateChanged()` so the UI re-polls. Setting a destination clears it.
- Queued outputs contribute `pendingSat`; a successful broadcast records `lastSweep`
  (one non-critical `sweep_last` storage key) and pings state-changed again.

### 3. PWA: single-channel lifecycle — new pure `core/channel-lifecycle.ts`

One derivation, consumed by everything channel-related:

```
none → opening → active → degraded (0 usable)
                → closed-needs-address | closed-recovering | closed-recovered → none
```

Input: `{ running, channels, usableChannels, closes, sweep, hasChannelState }`.
Since the app models exactly one channel, UI decisions use the most recent close;
history keeps all records. Pure function + unit test per phase transition.

### 4. Controller

`wallet-controller.ts` `getState()` gains:
- `closes`: `{ count, last?: ChannelCloseRecord }` (readable with node stopped),
- `sweep`: the SDK `getSweepStatus()` shape (defaults when stopped/demo).
No new event plumbing — the existing `state-changed` → re-poll pattern carries it.
Demo mode: fake wallet never closes a channel; fields get safe defaults.

### 5. Status pill (`core/status-pill.ts`)

The ladder becomes a lookup over the lifecycle state. New rungs between "node
stopped" and the existing no-channel rung:

1. `closed-needs-address` → **bad** — "Channel closed — set a recovery address to get
   your funds" → `screen-sweep`
2. `closed-recovering` → **info** — "Channel closed — recovering your funds on-chain"
   → `screen-sweep`
3. `none` with a close record → **warn** — "Channel closed — get a new one" →
   `screen-get-channel`
4. `none` with no close record → existing first-run copy, unchanged.

`opening`/`degraded` keep today's rung ("Channel opening — this can take a bit" /
info) — no copy change in this work.

`status-pill.test.ts` pins the new priorities (needs-address outranks recovering
outranks closed-get-new outranks backup nags).

### 6. Onboarding fix

- `core/onboarding-flow.ts` `currentOnboardingStep` gains `everHadChannel`
  (close record exists OR `hasChannelState`); the channel step fires only when
  `channels === 0 && !everHadChannel`.
- `screens/onboarding.ts`: add the missing `done` guard to the `onControllerEvent`
  re-evaluate so a mid-session close can never re-summon the overlay.

### 7. Channels screen, home, get-a-channel, history

- `screens/channels.ts` empty state becomes phase-aware: "Your channel closed
  <relative time>" + sweep status line ("funds recovering" / "N sats sent to your
  recovery address") + Get-a-channel button. `none`-never keeps today's copy.
- `screens/home.ts`: while in a closed phase, the hero shows a sub-line
  ("recovering N sats") so balance 0 isn't unexplained.
- `screens/get-channel.ts`: in `none`-after-close, framing is "Get a new channel"
  (not first-channel copy).
- `screens/transactions-sheet.ts` + `core/tx-format.ts`: merge close/sweep rows into
  the day-grouped list — "Channel closed" and "Recovered N sats on-chain" (once
  swept). createElement/textContent only (no record string touches innerHTML).

## Testing (TDD, per repo rules)

- SDK (real LDK WASM, no LDK mocks): fire `Event_ChannelClosed` through dispatch →
  assert persisted record + rehydration + `getChannelCloses()` with node stopped;
  sweep-status transitions (no-address → `needsAddress`, set address → clears,
  broadcast → `lastSweep`); extend `event-dispatch-minify-safe.test.ts`.
- PWA pure cores: `channel-lifecycle` (case per transition), `status-pill` new
  priorities, `onboarding-flow` `everHadChannel` cases, `tx-format` merge.
- PWA DOM (real `index.html`, `start-regression.test.ts` style): close-aware channels
  empty state renders; onboarding overlay does NOT appear for a running wallet with a
  close record and 0 channels.

## Invariants / non-goals

- No storage-contract changes: all new keys are non-critical (payment-history class).
- No change to sweep behavior — funds move exactly as before; this adds observability.
- Backup format untouched (`close_*`/`sweep_last` excluded like `tx_*`).
- Demo mode must not require or display any real data (safe defaults; no new demo
  surface).
