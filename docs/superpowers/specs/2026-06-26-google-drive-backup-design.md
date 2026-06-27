# Automatic Google Drive Backup — Design

**Date:** 2026-06-26
**Status:** Approved (design)
**Branch:** `feat/drive-backup`
**Builds on:** the backup engine (`exportState`/`importState`) and `getStateVersion()` + the
backup-status UX shipped on master.

## Problem

The wallet's encrypted backup is a file the user must download and keep current manually. Users don't
reliably do that, and a stale channel-state backup is risky. The user wants the encrypted backup to
sync **automatically to their own Google Drive** — so it stays current with no manual step, while the
project still stores nothing (the backup lives in the *user's* Drive, encrypted with their seed).

## Goal

Auto-sync the seed-encrypted backup blob to the user's Google Drive whenever channel state changes
(while the app is open and connected), and restore from Drive on a fresh/wiped browser. Keep the
manual Download/Restore as a fallback. No project-run server; the blob is unreadable to Google.

### Non-goals
- No project backend, no Drive access by the project. The app talks directly to Google's API from
  the browser using the user's own OAuth credential; the user's Drive holds the file.
- No change to the encryption model (seed-derived AES-256-GCM).
- No true background sync when the app is fully closed (a browser can't; see Limitations). Channel
  state only changes while the wallet runs, so this is acceptable.
- Not in the core SDK — the SDK stays platform-neutral (per guardrails). Drive lives in the example
  app (the host app), consistent with the dependency-injection model.

## Honest limitations (designed-around, stated in UI)
- **Open + signed-in only.** Auto-upload happens while the app is open and the Drive token is valid.
  Because channel state only changes while the wallet is *running*, every change is captured on the
  next debounced tick. The manual Download remains a fallback.
- **Offline NWC wake-ups** (the push gateway waking a closed tab's service worker to pay) change
  state without a foreground token; that change syncs on the **next foreground open**.
- **Token expiry (~1 hr).** Google access tokens are short-lived; the browser token flow has no
  silent refresh without a backend, so the user re-clicks "Connect Google Drive" occasionally. The UI
  shows connection status and prompts re-connect when a request returns 401.
- The **seed** remains the ultimate recovery regardless.

## Google Cloud setup (the user does this once; exact steps in the plan)
1. In Google Cloud Console, pick an existing project or create one.
2. Enable the **Google Drive API**.
3. Configure the **OAuth consent screen** (External; add yourself as a test user while unverified).
4. Create an **OAuth 2.0 Client ID**, type **Web application**; add **Authorized JavaScript origins**:
   `http://localhost:5173` (dev) and any production origin.
5. Copy the **Client ID** into the app's "Google Client ID" field (persisted in `localStorage`).
   (Production would inject it as a build env var instead.)

Scope used: `https://www.googleapis.com/auth/drive.appdata` (a private, app-only hidden folder).

## Architecture

A focused, dependency-light module plus UI wiring in the example app:

- **`packages/example-app/src/drive-backup.ts`** — the Drive client. One clear responsibility:
  authenticate and move the encrypted blob to/from the user's `appDataFolder`. Interface:
  - `loadGis(): Promise<void>` — inject the Google Identity Services script once.
  - `connect(clientId: string): Promise<void>` — run the OAuth token flow; hold the access token in
    memory (not persisted — short-lived secret).
  - `isConnected(): boolean`
  - `uploadBackup(contents: string): Promise<void>` — find the existing `libre-wallet-backup.json` in
    appDataFolder; if present `PATCH` its media, else multipart-create it (so there is always exactly
    one current file).
  - `downloadBackup(): Promise<string | null>` — find the file and return its contents, or null.
  - `disconnect(): void` — drop the in-memory token.
  - On any Drive request returning 401, throw a typed "reconnect needed" error the UI surfaces.
- **`packages/example-app/src/main.ts`** — wiring: a Client-ID field, a "Connect Google Drive"
  button + status, the auto-upload trigger, and a "Restore from Google Drive" action.

### Drive REST calls (scope `drive.appdata`, `Authorization: Bearer <token>`)
- Find: `GET /drive/v3/files?spaces=appDataFolder&q=name='libre-wallet-backup.json'&fields=files(id)`
- Create: `POST /upload/drive/v3/files?uploadType=multipart` with metadata
  `{name:'libre-wallet-backup.json', parents:['appDataFolder']}` + the blob.
- Update: `PATCH /upload/drive/v3/files/{id}?uploadType=media` with the blob.
- Download: `GET /drive/v3/files/{id}?alt=media`

## Component — auto-upload trigger

Reuse the `getStateVersion()` signal (and the existing backup-status refresh tick):
- Track `lastDriveSyncedVersion` (in memory; seeded from `localStorage` key `libre_drive_synced_version`).
- When connected and `wallet.getStateVersion() > lastDriveSyncedVersion`, start a **debounce** (e.g.
  reset a 5s timer on each change); when it fires, `uploadBackup(await wallet.exportState())`, then set
  `lastDriveSyncedVersion = wallet.getStateVersion()` (and persist it).
- The **backup-status indicator** gains Drive sub-states: "Drive: syncing…", "Drive: synced ✓ (vN)",
  "Drive: not connected", "Drive: reconnect needed".

## Component — connect & status UI

- A **"Google Client ID"** text field (persisted to `localStorage` key `libre_google_client_id`).
- A **"Connect Google Drive"** button → `loadGis()` + `connect(clientId)`; shows connected status.
- A **"Back up to Drive now"** button for an immediate manual upload.

## Component — restore from Drive

- The existing restore-on-empty banner gains a **"Restore from Google Drive"** action: Connect →
  `downloadBackup()`; if a blob is found, the user enters their seed → `importState(blob, seed)` →
  prompt to Start. The manual file picker stays alongside it.

## Error handling
- All Drive calls: non-2xx throws a typed Error logged to the in-app console; 401 → "reconnect
  needed" state (no silent catch). Upload failures leave `lastDriveSyncedVersion` unchanged so the
  next tick retries. Missing/invalid Client ID → a clear message, not a crash.

## Testing strategy
- The example app has **no test runner**, and OAuth + the Drive API require live Google credentials,
  so automated tests are out of scope (consistent with the repo's existing example-app tasks). The
  gate is `tsc && vite build` plus **documented manual test steps** (in the plan): set Client ID →
  Connect → open a regtest channel (state change) → confirm a file appears in Drive's app-data and the
  indicator shows "synced" → wipe IndexedDB → Restore from Drive → enter seed → Start → same node id.
- The `drive-backup.ts` module is kept small and pure-ish (request construction + create-vs-update
  decision) so it's reviewable by reading.

## Deliverables
1. `drive-backup.ts` — GIS auth + appDataFolder upload/download client.
2. example-app: Client-ID field + Connect/status + "Back up to Drive now".
3. example-app: auto-upload-on-change (debounced, keyed off `getStateVersion()`), Drive sub-states in
   the backup indicator.
4. example-app: "Restore from Google Drive" in the restore flow.
5. Plan includes the exact Google Cloud setup steps + manual test script.
