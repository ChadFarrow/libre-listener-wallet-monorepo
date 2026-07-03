# Browser Extension Auto-Start — Design

**Date:** 2026-07-03
**Package:** `@libre/browser-extension`
**Status:** Approved

## Problem

The extension wallet only runs after the user opens the popup and clicks Start. On browser
launch the offscreen document doesn't exist, so the node is offline: it can't receive payments,
serve NWC requests, or keep its channel alive. Unlike the PWA (which needs a tab open), the
extension's offscreen document can host the node for the whole browser session — auto-start
makes the wallet *always online* with zero clicks.

## Goals

- Node starts automatically on browser launch, extension install/update, and any lazy creation
  of the offscreen document (e.g. a WebLN request arriving before the popup is ever opened).
- A funded wallet also reconnects its channel peer automatically.
- The local auto-download backup keeps working across restarts with the popup never opened
  (user requirement: "auto backup stays on if turned on").
- Default **on**, with a popup toggle to disable.

## Non-Goals

- `chrome.alarms` watchdog for a crashed offscreen document (deferred).
- Google Drive token survival across SW restarts (Drive backup remains deferred; the local
  rolling backup file is the restart-safe backup).

## Design

### 1. `auto_start` flag

- Stored in `chrome.storage.local` via the existing `chromeKV`, key `auto_start`.
- **Default on**: unset or `"1"` → enabled; `"0"` → disabled. Encoded by a pure helper
  `isAutoStartEnabled(raw: string | null): boolean` in `core/auto-start.ts`.
- Popup gets an "Auto-start node" checkbox next to the auto-backup toggle, wired via the
  existing `WALLET_COMMAND` pattern (`getAutoStart`/`setAutoStart` handled in the background,
  same shape as `getAutoDownload`/`setAutoDownload`).
- The offscreen host reads the flag directly through `chromeKV` (chrome.storage.local is
  shared across extension contexts).

### 2. Persisted peer: `ExtensionConfig.peer`

- New optional field `peer?: string`, format `pubkey@host:port`, in the JSON stored under the
  existing `ldk_config` key. Additive — `parseConfig` treats it like the other optional string
  fields, so old configs parse unchanged and **no storage-contract invariant moves**.
- `WalletHost.connectPeer()` persists the string after every successful manual connect. It
  writes the config JSON directly to the network's storage (not via `setConfig`, which refuses
  while the node runs).
- The popup pre-fills its peer pubkey/host/port fields from `config.peer` falling back to
  `defaultPeer(network)` (they are blank today).

### 3. `autoStartPlan` — pure decision logic

`core/auto-start.ts` exports:

```ts
interface AutoStartInputs {
  flagRaw: string | null;      // raw chromeKV value for auto_start
  hasSeed: boolean;
  hasChannelState: boolean;    // channel_manager key present
  createdNew: boolean;         // wallet_created_new provenance marker
}
interface AutoStartPlan {
  start: boolean;
  connectPeer: boolean;
  reason?: string;             // human-readable skip reason, for logging
}
function autoStartPlan(i: AutoStartInputs): AutoStartPlan
```

Semantics mirror the PWA's `assessStartReadiness`:

| Case | start | connectPeer |
|---|---|---|
| flag disabled | no | no |
| no seed | no | no |
| seed, no channel state, NOT created-new-here | **no** (force-close risk — never throw this path into an unattended boot) | no |
| seed, no channel state, created-new-here | yes | **no** (brand-new wallet never auto-dials — mirrors the PWA gating) |
| seed + channel state | yes | yes |

### 4. `WalletHost.autoStart()` — non-throwing orchestrator

- Reads the flag + storage markers, computes the plan, logs the skip reason if not starting.
- If `start`: calls `startNode()` (whose readiness guard stays as defense-in-depth).
- If `connectPeer`: parses `config.peer || defaultPeer(network)` and dials with a fixed backoff
  schedule — delays `[2s, 4s, 8s, 16s, 30s]`, giving up after the last attempt. The bridge may
  not be reachable the instant the browser launches; after one successful connect the SDK's
  built-in peer auto-reconnect owns the link.
- Every failure is caught and `console.warn`ed — auto-start must never wedge the host or leave
  a half-built wallet (a failed `startNode()` already clears `this.wallet`).
- `startNode()` gains an in-flight promise guard (concurrent calls await the same promise) so
  `autoStart()` racing a popup Start click cannot double-build the wallet.

### 5. Triggers

- `offscreen.ts`: after registering the `WALLET_RPC` listener, kick
  `void host.autoStart().catch(...)` at module load. The node therefore comes up whenever the
  offscreen document is created, regardless of who created it or why.
- `background.ts`: `chrome.runtime.onStartup` and `chrome.runtime.onInstalled` listeners that
  just call `ensureOffscreen()` — the offscreen boot does the rest.

### 6. Auto-backup continuity

No code change. The `auto_download_backup` flag is already persisted and re-read on every
`state-changed` event, and the offscreen node's `chrome.runtime.sendMessage` wakes a dead
background SW. Auto-start simply means those events now flow without the popup ever opening.
Known gap (accepted): Drive auto-sync pauses after an SW restart until the user reconnects,
because the OAuth token is memory-only — Drive is deferred.

## Error handling

- `autoStart()` never throws; skips are logged with the plan's `reason`.
- Peer-connect exhausting its backoff schedule leaves the node running (chain-synced, able to
  be dialed by config changes later); the SDK reconnects nothing it never connected, so the
  popup's manual Connect Peer remains the recovery path.
- A `startNode()` failure inside `autoStart()` is caught and logged; the host stays in the
  stopped state and the popup Start button still works.

## Testing (TDD, vitest, existing package pattern: pure logic extracted + unit-tested)

- `core/auto-start.test.ts`: `isAutoStartEnabled` (unset/`"1"`/`"0"`), `autoStartPlan` for all
  five table rows — the seed-without-state skip is the critical force-close case — and the
  backoff schedule constant.
- `core/wallet-config.test.ts`: `parseConfig`/`serializeConfig` round-trip with `peer`;
  missing/blank `peer` parses to `undefined` (backward compat).
- A peer-string parse helper (`pubkey@host:port` → parts, invalid → error) unit-tested.
- Chrome-API glue (event listeners, checkbox wiring) stays thin and untested, per package
  convention.
- Manual verification: enable auto-backup → restart browser → receive/send a payment → the
  rolling backup file's mtime updates with the popup never opened; and browser relaunch with a
  funded wallet shows the node running + peer connected in the popup.

## Security notes

- Auto-connect dials the saved/default peer with no user gesture — intentional, and gated on
  channel state existing (keeping a funded channel alive), exactly mirroring the PWA's
  auto-connect rule. A brand-new unfunded wallet never auto-dials.
- The stateless-seed force-close path (`seed present, no channel state, not created here`)
  is a silent skip in `autoStartPlan` AND still a hard error in `startNode()` — two layers.
- No new externally-reachable surface: the triggers are internal lifecycle events; the WebLN
  gate and sender guards are untouched.
