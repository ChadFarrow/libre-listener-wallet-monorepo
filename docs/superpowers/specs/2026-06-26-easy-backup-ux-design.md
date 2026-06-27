# Easy, Trustworthy Downloadable Backup — Design

**Date:** 2026-06-26
**Status:** Approved (design)
**Branch:** `feat/easy-backup-ux`
**Builds on:** the Phase 1 backup engine (`state-backup.ts`, `exportState`/`importState`) and the
continuous ChannelManager persistence added in `feat/new-wallet-button`.

## Problem

The wallet is non-custodial and browser-resident, and **browser storage is not durable** (ITP
eviction, cleared data, lost device). The user's chosen mitigation is a **user-downloaded encrypted
backup file** — no server, nothing stored by the project. Phase 1 shipped the mechanism
(`exportState`/`importState` + a manual download/restore UI), but two gaps make it untrustworthy in
practice:

1. **The file goes stale silently.** Channel state changes on every payment, but the user has no
   signal that their last download is now behind — and restoring a *stale* channel backup risks a
   penalty. Browsers cannot silently re-save a file (downloads require a user gesture), so "stay
   current" must mean *prompting*, not auto-saving.
2. **A wiped browser starts fresh silently.** On a new/cleared browser the app just boots an empty
   wallet, with no nudge to restore from the file the user has.

## Goal

Make the downloadable backup **easy and trustworthy**: the user always knows whether their file is
current, fixes it in one click, and a wiped browser guides them to restore. No server, no remote
storage, no Nostr — the user downloads and keeps the file.

### Non-goals (explicit)
- No remote/automated backup server, no cloud sync, no Nostr backup. Nothing is stored anywhere the
  project or a third party operates.
- No silent auto-download (browsers disallow it).
- No change to the encryption model (seed-derived AES-256-GCM from Phase 1).

## Recovery model (unchanged, restated)

- **Seed** = root backup (static; written down / saved once). Recovers funds via the peer's
  data-loss-protect force-close even if the file is lost or stale — *seed = never lose money*.
- **Encrypted file** = seed + latest channel state in one blob. Lets you *resume channels exactly*
  without a force-close — *file = resume channels as they were*. Its value depends on being current.

## Component 1 — SDK: authoritative "state changed" signal

The app needs a trustworthy answer to "has channel state changed since the last download?" The
authoritative source is LDK's persistence signal, which the wallet already checks each event tick
(`get_and_clear_needs_persistence()` at `index.ts:588`).

Add a **monotonic state-version counter** that increments exactly when the ChannelManager is
persisted, persisted to storage so it survives reloads (channel state only changes while the node is
running, so the counter is stable across a closed browser):

- New storage key `state_version` (integer as string). Loaded on `start()` (default `0`).
- In the event tick, when `get_and_clear_needs_persistence()` is true and we persist
  `channel_manager`, increment the in-memory counter and write `state_version`.
- New public method: `getStateVersion(): number`.

This is a small, additive change; existing behavior is unaffected.

## Component 2 — example-app: backup-status indicator + one-click download

A small "Backup" status component in the wallet card:

- Track `lastBackedUpVersion` in `localStorage`.
- On the app's existing UI refresh tick, read `wallet.getStateVersion()`:
  - `version === 0 && no prior backup` → **"No backup yet — Download"** (warning).
  - `version > lastBackedUpVersion` → **"⚠️ Backup out of date — Download"** (warning).
  - else → **"Backup up to date ✓"** (ok).
- **Download** button calls `exportState()`, saves `libre-wallet-backup-<ts>.json`, then sets
  `lastBackedUpVersion = wallet.getStateVersion()` in `localStorage`.
- This reuses the existing export button/handler; it gains the status text + the version bookkeeping.

## Component 3 — example-app: restore-on-empty prompt

On page load, after the seed/network restore logic, check storage for an existing wallet
(`ldk_seed`). If **absent** (fresh/wiped browser), show a prominent **"Restore from backup"** banner
near the top of the wallet card that points at the existing file-import controls, so a wiped browser
guides the user to their file instead of silently starting fresh. When a wallet exists, the banner
is hidden.

## Component 4 — example-app: make the seed easy to save

The seed is the root backup, so surface it clearly: keep the existing Show toggle and add a small
**"Copy seed"** affordance with a one-line reminder ("Your seed is your master backup — keep it
safe"). No new crypto; purely UX.

## Honest staleness handling

The indicator nudges a re-download after each state change; restore additionally shows a one-line
caution that an outdated file may be behind the latest channel state and that the seed remains the
ultimate recovery. We do not attempt to detect staleness *of a file being imported* (we can't compare
it to on-chain truth) — the live indicator keeps the on-disk file fresh instead.

## Testing strategy

Per `ai/contracts/testing-strategy.md` (no LDK mocking; assert outcomes):

- **SDK unit/integration:** assert `getStateVersion()` starts at 0, increments after a channel state
  change, and persists across a stop/restart (extend the existing `persistence.test.ts` pattern, or
  the regtest `lsps2`/`keysend-send` flows where a channel opens). A focused unit test can drive a
  state change via the persistence path.
- **example-app:** `tsc && vite build` is the gate (no automated UI tests in this repo); the
  indicator/restore-banner logic is small and pure.

## Deliverables
1. SDK: `state_version` persistence + `getStateVersion()` (`index.ts`).
2. example-app: backup-status indicator + version bookkeeping on download.
3. example-app: restore-on-empty banner.
4. example-app: seed copy/visibility affordance.
5. SDK test for `getStateVersion()` increment + persistence.
