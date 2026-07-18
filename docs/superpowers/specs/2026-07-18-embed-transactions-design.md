# Embed Transactions — expose the data, no embed UI

**Date:** 2026-07-18
**Package:** `@libre/wallet-embed`

## Goal

Make the wallet's unified payment log **available to the apps that use the embed**, so each app can display it however it wants. **No transaction UI is built in the embed itself** — the embed only exposes data.

"Apps that use the embed" = apps that pay/receive **through this wallet** (embed WebLN or NWC). They share one unified log; a separate app with its own wallet does not write to it.

## Current state (verified in code)

- **Recording:** every payment through the embed is captured by the SDK `PaymentLogger` as a `tx_<id>` key. Shape: `packages/shared/src/payment-record.ts` (`PaymentRecord`).
- **Drive persistence — already works.** `session-wiring.ts` auto-syncs to Drive on `state-changed` (debounced, gated on running + `driveConnected` + session `view === "running"`); `flushTracked()` → `controller.exportBackup()` enumerates the `tx_*` records into the encrypted envelope (`index.ts:1662-1672`). **Goal's "save to Drive" half is met by existing code — verify only.**
- **Reading — not exposed.** `MountHandle` (`index.ts:51-64`) exposes `webln` / `state()` / `onState()` / `dispose()` — no transactions accessor. `WalletController.getPayments(): Promise<PaymentRecord[]>` exists (`wallet-core/src/wallet-controller.ts:961`) and works even when the node is **stopped** (fresh logger over storage) — it's just not surfaced through the embed.
- **NWC clients already have a read path:** `list_transactions` (served while the wallet is running) is backed by the same `PaymentLogger`.

## Scope — the whole build

Add two read-only members to the embed's public `MountHandle` (the object `mountLibreWallet` returns, held only by the app that mounted the embed):

1. `getTransactions(): Promise<TxView[]>` — the unified log, newest-first, mapped to a stable display shape. Calls `controller.getPayments()`.
2. `onTransaction(cb: (tx: TxView) => void): () => void` — fires when a newly-settled record appears (diff on the controller `state-changed` seam already threaded through `createEmbedSession` via `onControllerEvent`). Returns an unsubscribe fn. Lets a host render a live feed without polling.

That's it. No `element.ts` changes, no `tx-format` move (each app formats its own way), no server.

## Data shape

```ts
interface TxView {
  id: string;              // payment hash
  direction: "sent" | "received";
  status: "pending" | "settled" | "failed";
  amountSats: number;
  feeSats?: number;
  timestamp: number;       // ms epoch
  settledAt?: number;
  counterparty?: string;   // node pubkey
  type?: "keysend" | "bolt11";
  note?: string;           // boostagram note / message
}
```

Maps `PaymentRecord` 1:1 **minus `preimage`** — a feed doesn't need payment receipts, and omitting them keeps the convenience API to display data only. (The host shares the origin, so this is least-surprise hardening, not a security boundary.) If a real need for preimages appears, revisit.

## Boundaries

- **Not on `window.webln`.** History is a control-plane read; the WebLN surface stays locked to the 6 spend methods (the security gate). Only the app that called `mountLibreWallet` gets `getTransactions`/`onTransaction`, via the returned handle.
- **Read-only, moves no funds.**
- **Availability:** `getTransactions()` works whenever the embed session exists, including node stopped (reads storage). It reflects whatever this wallet has recorded + roamed in from Drive.

## Out of scope (YAGNI)

- Any embed-rendered transaction UI.
- Railway/gateway storage — Drive covers persistence, this API covers app access; avoids the zero-custody-guardrail departure.
- Separate append-only Drive history file — upgrade path only if history reaches many thousands of records (whole-backup re-upload per sync is fine at KB–hundreds-of-KB scale).
- Any host app's own feed UI — unlocked by this API, built by each app.

## Testing

- **mount/index test:** `getTransactions()` returns mapped records (no `preimage`), newest-first; works with the node stopped; `onTransaction` fires once per newly-settled record and the returned unsubscribe stops it.
- **Persistence (verify):** embed-level assertion that a payment recorded through the embed's controller rides into `exportBackup()`'s enumerated entries (SDK already tests `tx_*` enumeration; this pins the embed path).
- **Storage contract:** unaffected — no on-disk format change; `getPayments` reads existing `tx_` keys. `pnpm check:storage` stays green.

## Notes for consuming apps (doc, non-code)

- Read on demand via `getTransactions()`; subscribe via `onTransaction` for live updates.
- Records only exist while/after payments flow through this wallet; a fresh roam-in carries prior history from the Drive backup.
- NWC-connected apps can alternatively use `list_transactions` (works while the wallet is running).
