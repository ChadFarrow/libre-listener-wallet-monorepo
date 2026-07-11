# On-device diagnostic log buffer (wallet-pwa)

**Date:** 2026-07-11
**Status:** Approved (design), pending implementation plan
**Package:** `@libre/wallet-pwa` only (no SDK changes)

## Problem

iOS lifecycle bugs (background/resume stalls, storage eviction, zombie sockets, overnight
freezes) only reproduce on a real device, and the app's console output exists only while a
Mac + cable + Web Inspector are attached. An overnight/background failure leaves no trace —
e.g. the 2026-07-11 fallen-behind panic produced a console full of decisive evidence that
would have been lost without the desktop inspector open. A dedicated test iPhone (iOS 26)
is being set up; it needs cable-free retrievable logs. This buffer is also the foundation
for a later dev-mode on-device soak (out of scope here).

## Decision summary

- **Always on** (user choice): records continuously on every device with a modest ring cap.
  The unplanned bug is the one that needs logs.
- **Tap at the console** (approach A): every log line already flows through `console.*` —
  the SDK's injected logger calls `console.log("[LDK]", …)` (single site in
  `wallet-controller.ts` `buildWallet`) and ~34 app-layer sites call it directly. One
  wrapper captures everything with zero per-site changes. No SDK changes; no remote beacon.
- **Separate IndexedDB** (`libre-diagnostics`): its own DB — zero wallet
  storage-contract risk, invisible to the wallet's `keys()` scans, wiped independently.

## Design

### 1. Pure core — `src/core/diag-log.ts` (new, DOM-free, fully tested)

- Entry shape: `{ at: number /*ms epoch*/, level: "log" | "warn" | "error" | "event", msg: string }`.
- `createDiagBuffer(opts)` returning pure operations over internal state:
  - `add(level, msg)` → applies policy, returns whether a flush is due.
  - Ring cap: default **4000 entries** — oldest dropped on overflow.
  - **TRACE filter:** lines containing `"[TRACE]"` are dropped by default (LDK trace spam
    is most of the volume and is available via cable when needed).
  - **Per-line truncation:** default **2000 chars** (NWC wire-payload lines are huge),
    truncated with a `…[+N chars]` suffix.
  - **Batch policy:** flush due after **50 unflushed entries** or **2 s** since the first
    unflushed entry (time injected — no `Date.now()` inside decisions; callers pass `now`).
  - `drainUnflushed()` / `snapshot()` / `clear()` / `count()`.
- Formatting: `formatDiagLines(entries)` → plain text `ISO-8601 LEVEL message` lines
  (greppable; the export file body).

### 2. The tap — `src/core/diag-tap.ts` (new) wired FIRST in `main.ts`

- Wraps `console.log`, `console.warn`, `console.error`: original is always called through
  (Web Inspector unaffected), then the joined-args string is `add()`-ed. Args joined with
  spaces; non-strings via `String()`/`JSON.stringify` best-effort.
- Hooks `window.onerror` and `unhandledrejection` → `error` entries (message + stack head).
- Records **lifecycle events** as `event` entries: `visibilitychange` (with the new state),
  `pagehide` / `pageshow` (with `persisted`), `freeze` / `resume`, `online` / `offline`.
  These timestamps are the backbone of overnight diagnosis.
- **Immediate flush on `visibilitychange → hidden` and `pagehide`** — the lines just before
  a backgrounding are the ones that matter, and issued IndexedDB puts complete even if the
  page is killed after (the browser process owns them).
- **Reentrancy guard:** a module flag suppresses recording while inside the tap so a
  diagnostics failure can never recurse or break app logging; storage errors are swallowed
  after one pass-through `console.warn` (via the ORIGINAL console, not the wrapper).

### 3. Storage — `src/core/diag-store.ts` (new)

- Own IndexedDB: **`libre-diagnostics`**, version 1, single object store `entries`
  (autoIncrement key). NOT the wallet DB; NOT covered by (and must never touch) the wallet
  storage contract. Delete-all wipes it too (`indexedDB.deleteDatabase` is fine here — this
  DB is disposable by definition).
- Batched `append(entries[])` in one transaction per flush; `readAll()`; `clear()`;
  `count()`. Ring enforcement on write: when count exceeds cap, delete oldest overflow in
  the same transaction (approximate is fine; policy exactness lives in the pure core).
- On boot, the tap loads nothing — the buffer starts empty in memory and the DB holds
  history; export reads DB + drains the in-memory tail so the file is complete.

### 4. Developer-settings UI (`src/screens/developer.ts` + `index.html`)

A "Diagnostics" card:
- Readout: entry count + approximate size (`~N entries · ~X KB`).
- **Export diagnostics:** builds the text file (`libre-diag-<network>-<YYYY-MM-DD-HHmm>.txt`).
  iOS/standalone: `navigator.share({ files: [File] })` → share sheet (AirDrop to the Mac,
  Save to Files). Fallback (desktop / share unavailable): blob download, same pattern as
  the backup-file export in `cloud-backup.ts`.
- **Clear diagnostics:** empties DB + memory (no confirm modal — it's disposable data; a
  `setMsg` confirmation line suffices).

### 5. Privacy / guardrails

- Local-only. Never auto-uploaded anywhere; export is user-initiated. (Approach C — a
  remote log beacon — was explicitly rejected.)
- The existing key-isolation rule (seeds, private keys, preimages never logged) is what
  keeps the buffer clean; this feature adds no new sensitive lines and future log lines
  must continue to honor it. The buffer stores only what was already sent to the console.
- Demo mode: records normally (local + harmless); no special-casing.

### 6. Out of scope (v1)

- Service-worker log capture (separate JS context; needs postMessage plumbing).
- The dev-mode on-device soak (next feature; writes into this buffer).
- Log levels/filtering UI, log search, remote upload.

## Testing (TDD)

- `core/diag-log.test.ts`: ring cap overflow, TRACE drop, truncation with suffix, batch
  triggers (count and elapsed-time paths, injected clock), drain/clear/snapshot, formatter
  output shape.
- `core/diag-tap.test.ts` (jsdom): console wrapper calls through AND records; reentrancy
  guard (a throwing store never recurses); error-hook capture; lifecycle events recorded
  on dispatched `visibilitychange`/`pagehide`.
- `core/diag-store.test.ts` (fake-indexeddb, same as existing PWA tests): append/readAll
  round-trip, ring enforcement, clear.
- DOM test (existing harness pattern): the developer-screen export path produces a file
  containing recorded lines (share/download stubbed).
- No storage-contract test changes — and that absence is itself the invariant (`libre-diagnostics`
  is not part of the wallet contract).
