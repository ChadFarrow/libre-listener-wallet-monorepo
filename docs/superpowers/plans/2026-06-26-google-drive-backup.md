# Automatic Google Drive Backup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-sync the seed-encrypted wallet backup to the user's own Google Drive (`drive.appdata`) and restore from it, with no project backend.

**Architecture:** A focused `drive-backup.ts` client in the example app uses Google Identity Services (token flow) + the Drive REST API to store one encrypted file in the private app-data folder. The example app reuses `exportState()`/`importState()`/`getStateVersion()`; an auto-upload trigger fires on channel-state change (debounced). No core-SDK changes.

**Tech Stack:** TypeScript, Vite, Google Identity Services (`gsi/client`), Google Drive REST v3, browser `fetch`/`localStorage`.

## Global Constraints

- No core-SDK changes; all Drive code lives in the example app (SDK stays platform-neutral).
- No project backend/storage. The access token is held in memory only (never persisted).
- OAuth scope exactly `https://www.googleapis.com/auth/drive.appdata`. Backup filename exactly `libre-wallet-backup.json`.
- No silent catches: surface errors via `appendLog(..., "error")`; a 401 becomes a typed "reconnect needed" state.
- The example app has no test runner; the gate for every task is `pnpm --filter @libre/example-app build` (tsc && vite build). End-to-end OAuth/Drive is manual (script at the end; needs the user's real Client ID).
- camelCase functions; kebab-case files.
- Spec: `docs/superpowers/specs/2026-06-26-google-drive-backup-design.md`.

## Prerequisite (user does this once; needed only for the manual test, not the build)

1. Google Cloud Console → select/create a project.
2. APIs & Services → Library → enable **Google Drive API**.
3. APIs & Services → OAuth consent screen → External; add your Google account under **Test users**.
4. APIs & Services → Credentials → Create credentials → **OAuth client ID** → **Web application**.
   Under **Authorized JavaScript origins** add `http://localhost:5173`.
5. Copy the **Client ID**; paste it into the app's "Google Client ID" field (Task 1).

## File Structure

- Create `packages/example-app/src/drive-backup.ts` — GIS auth + Drive `appDataFolder` upload/download client.
- Modify `packages/example-app/index.html` — Google Drive controls in the Backup card.
- Modify `packages/example-app/src/main.ts` — wire connect/status, auto-upload, restore-from-Drive.

---

### Task 1: Drive client module + Connect UI

**Files:**
- Create: `packages/example-app/src/drive-backup.ts`
- Modify: `packages/example-app/index.html`
- Modify: `packages/example-app/src/main.ts`

**Interfaces:**
- Produces (`drive-backup.ts`):
  - `class DriveReconnectError extends Error`
  - `loadGis(): Promise<void>`
  - `connect(clientId: string): Promise<void>`
  - `isConnected(): boolean`
  - `disconnect(): void`
  - `uploadBackup(contents: string): Promise<void>`
  - `downloadBackup(): Promise<string | null>`

- [ ] **Step 1: Create the Drive client module**

Create `packages/example-app/src/drive-backup.ts`:

```ts
// Google Drive backup client for the example app.
// Google Identity Services (token flow) for OAuth + Drive REST against the private
// `drive.appdata` folder. Stores exactly one encrypted backup file. The access token
// is short-lived and kept only in memory (never persisted).

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const BACKUP_FILENAME = "libre-wallet-backup.json";
const GIS_SRC = "https://accounts.google.com/gsi/client";

let accessToken: string | null = null;
let gisLoaded = false;

export class DriveReconnectError extends Error {
  constructor() {
    super("Google Drive session expired — reconnect needed");
    this.name = "DriveReconnectError";
  }
}

export function isConnected(): boolean {
  return accessToken !== null;
}

export function disconnect(): void {
  accessToken = null;
}

export async function loadGis(): Promise<void> {
  if (gisLoaded) return;
  await new Promise<void>((resolve, reject) => {
    if (document.querySelector(`script[src="${GIS_SRC}"]`)) {
      gisLoaded = true;
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => {
      gisLoaded = true;
      resolve();
    };
    s.onerror = () => reject(new Error("Failed to load Google Identity Services"));
    document.head.appendChild(s);
  });
}

export async function connect(clientId: string): Promise<void> {
  if (!clientId) throw new Error("Missing Google Client ID");
  await loadGis();
  const google = (window as any).google;
  if (!google?.accounts?.oauth2) throw new Error("Google Identity Services not available");
  await new Promise<void>((resolve, reject) => {
    const tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (resp: any) => {
        if (resp.error) {
          reject(new Error(`OAuth error: ${resp.error}`));
          return;
        }
        accessToken = resp.access_token;
        resolve();
      },
    });
    tokenClient.requestAccessToken();
  });
}

async function driveFetch(url: string, init: RequestInit): Promise<Response> {
  if (!accessToken) throw new DriveReconnectError();
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401) {
    accessToken = null;
    throw new DriveReconnectError();
  }
  if (!res.ok) throw new Error(`Drive API error ${res.status}: ${await res.text()}`);
  return res;
}

async function findBackupFileId(): Promise<string | null> {
  const q = encodeURIComponent(`name='${BACKUP_FILENAME}'`);
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id)`,
    { method: "GET" }
  );
  const data = await res.json();
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

export async function uploadBackup(contents: string): Promise<void> {
  const existingId = await findBackupFileId();
  if (existingId) {
    await driveFetch(
      `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: contents }
    );
  } else {
    const boundary = "libreBackupBoundary";
    const metadata = { name: BACKUP_FILENAME, parents: ["appDataFolder"] };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
      `${contents}\r\n--${boundary}--`;
    await driveFetch(
      `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`,
      { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body }
    );
  }
}

export async function downloadBackup(): Promise<string | null> {
  const id = await findBackupFileId();
  if (!id) return null;
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${id}?alt=media`,
    { method: "GET" }
  );
  return await res.text();
}
```

- [ ] **Step 2: Add the Connect-to-Drive controls to the Backup card**

In `packages/example-app/index.html`, immediately after the Download button line:

```html
          <button id="export-state-btn" class="btn btn-primary" disabled>Download Encrypted Backup</button>
```

insert:

```html
          <div class="form-group" style="margin-top: 16px;">
            <label>Google Drive backup (optional)</label>
            <input type="text" id="google-client-id" placeholder="Paste your Google OAuth Client ID" />
            <div class="status-row" style="margin-top: 8px;">
              <button id="connect-drive-btn" class="btn btn-secondary">Connect Google Drive</button>
              <span id="drive-status" class="value">Drive: not connected</span>
            </div>
            <p class="help-text">Syncs your encrypted backup to your Drive's private app folder while the app is open. The file is encrypted with your seed — Google can't read it.</p>
          </div>
```

- [ ] **Step 3: Wire connect + status in main.ts**

In `packages/example-app/src/main.ts`, add the Drive import next to the existing imports (after the `import { IndexedDBStorageProvider } ...` line near the top):

```ts
import * as drive from "./drive-backup";
```

Add these lookups next to the other Backup element lookups (near `const backupStatusEl = ...`):

```ts
const googleClientIdInput = document.getElementById("google-client-id") as HTMLInputElement;
const connectDriveBtn = document.getElementById("connect-drive-btn") as HTMLButtonElement;
const driveStatusEl = document.getElementById("drive-status") as HTMLSpanElement;
```

Add this function + the on-load client-id restore + the connect handler at the end of the file:

```ts
function updateDriveStatus(text?: string) {
  if (text) {
    driveStatusEl.textContent = text;
  } else {
    driveStatusEl.textContent = drive.isConnected() ? "Drive: connected ✓" : "Drive: not connected";
  }
}

// Restore the saved Client ID so the user doesn't re-paste it each load.
const savedClientId = localStorage.getItem("libre_google_client_id");
if (savedClientId) googleClientIdInput.value = savedClientId;
updateDriveStatus();

connectDriveBtn.addEventListener("click", async () => {
  const clientId = googleClientIdInput.value.trim();
  if (!clientId) {
    appendLog("[ERROR] Paste your Google OAuth Client ID first.", "error");
    return;
  }
  localStorage.setItem("libre_google_client_id", clientId);
  try {
    updateDriveStatus("Drive: connecting…");
    await drive.connect(clientId);
    updateDriveStatus();
    appendLog("[SYSTEM] Connected to Google Drive.", "system");
  } catch (e) {
    updateDriveStatus("Drive: not connected");
    appendLog(`[ERROR] Google Drive connect failed: ${e instanceof Error ? e.message : e}`, "error");
  }
});
```

- [ ] **Step 4: Build (the gate)**

Run: `pnpm --filter @libre/example-app build`
Expected: `tsc && vite build` succeeds, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/example-app/src/drive-backup.ts packages/example-app/index.html packages/example-app/src/main.ts
git commit -m "feat: Google Drive backup client + Connect UI"
```

---

### Task 2: Auto-upload on change + manual "Back up to Drive now" + Drive indicator state

**Files:**
- Modify: `packages/example-app/index.html`
- Modify: `packages/example-app/src/main.ts`

**Interfaces:**
- Consumes: `drive.isConnected()`, `drive.uploadBackup()`, `drive.DriveReconnectError` (Task 1); `wallet.getStateVersion()`, `wallet.exportState()`; the existing `refreshBackupStatus()` + its 2s timer; `updateDriveStatus()`.

- [ ] **Step 1: Add the "Back up to Drive now" button**

In `packages/example-app/index.html`, inside the Google Drive `form-group`, change the status-row to include a manual-upload button:

```html
            <div class="status-row" style="margin-top: 8px;">
              <button id="connect-drive-btn" class="btn btn-secondary">Connect Google Drive</button>
              <button id="backup-drive-now-btn" class="btn btn-secondary">Back up to Drive now</button>
              <span id="drive-status" class="value">Drive: not connected</span>
            </div>
```

- [ ] **Step 2: Add the lookup + a shared upload helper + auto-upload trigger**

In `packages/example-app/src/main.ts`, add the lookup near the other Drive lookups:

```ts
const backupDriveNowBtn = document.getElementById("backup-drive-now-btn") as HTMLButtonElement;
```

Add a module-level debounce timer + synced-version tracker near the top-level state (e.g. just below the Drive lookups):

```ts
let driveSyncTimer: any = null;
let driveSyncing = false;
function loadDriveSyncedVersion(): number {
  const s = localStorage.getItem("libre_drive_synced_version");
  const n = s === null ? NaN : parseInt(s, 10);
  return Number.isNaN(n) ? -1 : n;
}
```

Add the shared upload helper + manual button handler at the end of the file:

```ts
async function uploadBackupToDrive(): Promise<void> {
  if (!wallet || !isNodeRunning) {
    appendLog("[ERROR] Start the node before backing up to Drive.", "error");
    return;
  }
  if (!drive.isConnected()) {
    appendLog("[ERROR] Connect Google Drive first.", "error");
    return;
  }
  driveSyncing = true;
  updateDriveStatus("Drive: syncing…");
  try {
    const version = wallet.getStateVersion();
    await drive.uploadBackup(await wallet.exportState());
    localStorage.setItem("libre_drive_synced_version", String(version));
    updateDriveStatus(`Drive: synced ✓ (v${version})`);
    appendLog(`[SYSTEM] Backup synced to Google Drive (v${version}).`, "system");
  } catch (e) {
    if (e instanceof drive.DriveReconnectError) {
      updateDriveStatus("Drive: reconnect needed");
      appendLog("[ERROR] Google Drive session expired — click Connect again.", "error");
    } else {
      updateDriveStatus("Drive: connected ✓");
      appendLog(`[ERROR] Drive sync failed: ${e instanceof Error ? e.message : e}`, "error");
    }
  } finally {
    driveSyncing = false;
  }
}

backupDriveNowBtn.addEventListener("click", () => {
  void uploadBackupToDrive();
});

// Auto-upload to Drive (debounced) whenever channel state advances past what's synced.
setInterval(() => {
  if (!wallet || !isNodeRunning || !drive.isConnected() || driveSyncing) return;
  if (wallet.getStateVersion() > loadDriveSyncedVersion()) {
    if (driveSyncTimer) clearTimeout(driveSyncTimer);
    driveSyncTimer = setTimeout(() => {
      driveSyncTimer = null;
      void uploadBackupToDrive();
    }, 5000);
  }
}, 2000);
```

- [ ] **Step 3: Build (the gate)**

Run: `pnpm --filter @libre/example-app build`
Expected: succeeds, no type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/example-app/index.html packages/example-app/src/main.ts
git commit -m "feat: auto-upload backup to Drive on change + manual sync button"
```

---

### Task 3: Restore from Google Drive

**Files:**
- Modify: `packages/example-app/index.html`
- Modify: `packages/example-app/src/main.ts`

**Interfaces:**
- Consumes: `drive.connect()`, `drive.isConnected()`, `drive.downloadBackup()` (Task 1); the existing restore pattern (`new LibreListenerWallet({...}); importState(blob, seed)`), `seedInput`, `networkSelect`, `esploraUrlInput`, `storage`, `BrowserWebSocketStreamProvider`.

- [ ] **Step 1: Add the "Restore from Google Drive" button**

In `packages/example-app/index.html`, inside the restore `<div style="margin-top: 12px;">` block, after the existing Restore button line:

```html
            <button id="import-state-btn" class="btn btn-secondary">Restore</button>
```

add:

```html
            <button id="restore-drive-btn" class="btn btn-secondary">Restore from Google Drive</button>
```

- [ ] **Step 2: Wire the restore-from-Drive handler**

In `packages/example-app/src/main.ts`, add the lookup near the other Drive lookups:

```ts
const restoreDriveBtn = document.getElementById("restore-drive-btn") as HTMLButtonElement;
```

Add the handler at the end of the file:

```ts
restoreDriveBtn.addEventListener("click", async () => {
  const seed = seedInput.value.trim();
  if (seed.length !== 64) {
    appendLog("[ERROR] Enter your 64-char hex seed above to decrypt the Drive backup.", "error");
    return;
  }
  try {
    if (!drive.isConnected()) {
      const clientId = googleClientIdInput.value.trim();
      if (!clientId) {
        appendLog("[ERROR] Paste your Google OAuth Client ID and Connect first.", "error");
        return;
      }
      await drive.connect(clientId);
      updateDriveStatus();
    }
    const blob = await drive.downloadBackup();
    if (!blob) {
      appendLog("[SYSTEM] No backup found in your Google Drive.", "system");
      return;
    }
    const importWallet = new LibreListenerWallet({
      config: {
        network: networkSelect.value as "mainnet" | "testnet" | "regtest" | "signet",
        esploraUrl: esploraUrlInput.value.trim(),
      },
      storage,
      socketProvider: new BrowserWebSocketStreamProvider(),
      wasmUrl: "/liblightningjs.wasm",
    });
    await importWallet.importState(blob, seed);
    appendLog("[SYSTEM] Backup restored from Google Drive. Click Start Node to boot the recovered wallet.", "system");
  } catch (e) {
    appendLog(`[ERROR] Restore from Drive failed: ${e instanceof Error ? e.message : e}`, "error");
  }
});
```

- [ ] **Step 3: Build (the gate)**

Run: `pnpm --filter @libre/example-app build`
Expected: succeeds, no type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/example-app/index.html packages/example-app/src/main.ts
git commit -m "feat: restore wallet from Google Drive backup"
```

---

## Manual test script (after the build, with a real Client ID)

Requires the Prerequisite Client ID and the regtest stack (`docker compose up -d && ./scripts/regtest-setup.sh`).

1. `pnpm --filter @libre/example-app dev`; open `http://localhost:5173`.
2. Paste your Client ID → **Connect Google Drive** → consent → status shows "connected ✓".
3. Network → regtest (or signet), **New Wallet**, **Start Node**, open a channel (regtest LSPS2 flow or the faucet on signet) so channel state changes.
4. Watch the indicator: it should show **Drive: syncing…** then **Drive: synced ✓ (vN)** within ~5s of the change. (Confirm in Drive: a file exists under the app's hidden data — visible via Google Drive "Manage apps" or the Drive API.)
5. DevTools → Application → IndexedDB → delete `libre-wallet`; reload.
6. Enter the **same seed** → **Restore from Google Drive** → "restored… Click Start Node" → **Start Node** → confirm the **same Node ID** returns.

## Self-Review

**Spec coverage:**
- Drive client module (GIS auth + appDataFolder upload/download, 401→reconnect) → Task 1. ✓
- Connect UI + Client-ID field (persisted) + status → Task 1. ✓
- Auto-upload on change (debounced, keyed off getStateVersion) + "Back up to Drive now" + Drive sub-states → Task 2. ✓
- Restore from Drive → Task 3. ✓
- `drive.appdata` scope, `libre-wallet-backup.json`, token in memory only, no SDK change → enforced across tasks. ✓
- Google Cloud setup steps + manual test script → Prerequisite + Manual test sections. ✓
- Non-goals (no backend, no SDK change, no silent catch) → nothing implements them; handlers use appendLog. ✓

**Placeholder scan:** No TBD/TODO; every step has concrete code/commands. The build is the only automated gate per the spec (no test runner in the example app; OAuth/Drive need live creds).

**Type consistency:** `drive-backup.ts` exports (`connect`, `isConnected`, `disconnect`, `uploadBackup`, `downloadBackup`, `loadGis`, `DriveReconnectError`) are consumed with matching names/signatures in Tasks 2–3; localStorage keys `libre_google_client_id` / `libre_drive_synced_version` and element ids (`google-client-id`, `connect-drive-btn`, `drive-status`, `backup-drive-now-btn`, `restore-drive-btn`) match between HTML and `main.ts`. `updateDriveStatus()` defined in Task 1 and reused in Tasks 2–3.

**Note:** the `status-row`/`label`/`value`/`form-group`/`help-text` classes and `text-warning` are existing CSS in the app (used by the backup card and elsewhere); no new CSS required.
