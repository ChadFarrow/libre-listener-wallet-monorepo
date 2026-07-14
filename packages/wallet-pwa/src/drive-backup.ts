// Google Drive backup client for the example app.
// Google Identity Services (token flow) for OAuth + Drive REST against the private
// `drive.appdata` folder. Stores exactly one encrypted backup file. The access token
// is short-lived and kept only in memory (never persisted).

import { buildDriveAuthUrl, parseDriveOAuthFragment } from "./core/drive-redirect";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
// 'email' lets us read the account address after consent and reuse it as a
// login_hint for silent reconnect on later loads (so the user isn't re-prompted
// every session). Scopes are space-separated for the GIS token client.
const AUTH_SCOPES = `${DRIVE_SCOPE} email`;
const GIS_SRC = "https://accounts.google.com/gsi/client";
// sessionStorage nonce for the redirect flow's CSRF `state` — survives the round-trip to Google in
// the same tab. A soft check: if it's lost, the token (bound to our client + redirect_uri) still works.
const OAUTH_STATE_KEY = "libre_drive_oauth_state";
// Persisted account email — the durable "cloud backup is set up" signal the onboarding gate reads
// (via drive-integration's rememberedEmail/driveConfigured). Owned here so EVERY connect path
// persists it; drive-integration imports this constant rather than re-declaring the string.
export const DRIVE_HINT_KEY = "libre_drive_hint";
// Durable "Drive has been connected here" flag, set the instant a token is obtained — BEFORE and
// independent of the async email lookup. driveConfigured() honors it, so the onboarding gate stays
// satisfied even if the email lookup fails (a network blip) or a token later expires. Reset only by
// the wallet-wide delete-all (localStorage.clear); a routine token expiry must never clear it.
export const DRIVE_CONFIGURED_KEY = "libre_drive_configured";

let connectedEmail: string | null = null;

/** Email of the connected account, learned from the 'email' scope. Persist this and
 *  feed it back as `hint` on silent reconnect. Null until a connect succeeds. */
export function getConnectedEmail(): string | null {
  return connectedEmail;
}

// Remember the learned account both in memory (this session) AND on disk. The on-disk copy is what
// keeps driveConfigured() true across a full app close — the in-memory `connectedEmail` is wiped
// when iOS reaps the installed PWA. Both connect paths (GIS popup + iOS full-page redirect) call
// this; before, only the popup path persisted, so an installed iOS PWA forgot Drive every launch
// and the onboarding gate re-prompted "Connect Google Drive" every morning.
function rememberEmail(email: string): void {
  connectedEmail = email;
  try {
    localStorage.setItem(DRIVE_HINT_KEY, email);
  } catch {
    /* storage disabled (private mode) — the in-memory email still serves this session */
  }
}

// Set the durable configured flag synchronously when a token lands (both connect paths), so the
// onboarding gate doesn't depend on the best-effort email lookup succeeding.
function markDriveConfigured(): void {
  try {
    localStorage.setItem(DRIVE_CONFIGURED_KEY, "1");
  } catch {
    /* storage disabled — driveConfigured falls back to the in-memory token/email this session */
  }
}

/** True once Drive has been connected on this device (persists across token expiry / app close). */
export function isDriveConfiguredPersisted(): boolean {
  try {
    return localStorage.getItem(DRIVE_CONFIGURED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Pure builder for the GIS token-client config. Silent reconnect uses
 * `prompt: 'none'` plus a `login_hint` (the remembered email) so an existing
 * Google session is reused without a popup; interactive uses `prompt: ''` (UI only
 * if needed). Exported for testing.
 */
export function buildTokenClientConfig(
  clientId: string,
  opts: { silent?: boolean; hint?: string } = {}
): { client_id: string; scope: string; prompt: string; hint?: string } {
  const cfg: { client_id: string; scope: string; prompt: string; hint?: string } = {
    client_id: clientId,
    scope: AUTH_SCOPES,
    prompt: opts.silent ? "none" : "",
  };
  if (opts.hint) cfg.hint = opts.hint;
  return cfg;
}

async function fetchAccountEmail(token: string): Promise<string | null> {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.email === "string" ? data.email : null;
  } catch {
    return null;
  }
}

// One backup file PER NETWORK so a regtest sync can't clobber the mainnet backup.
export function backupFilename(network: string): string {
  return `libre-wallet-backup-${network}.json`;
}

// Parse the network out of a backup filename, e.g. "libre-wallet-backup-mainnet.json" → "mainnet".
export function networkFromBackupFilename(name: string): string | null {
  const m = /^libre-wallet-backup-([a-z]+)\.json$/.exec(name);
  return m ? m[1] : null;
}

// When several networks have a backup, choose which to restore: prefer mainnet, else the first.
export function pickRestoreNetwork(networks: string[]): string | null {
  if (networks.includes("mainnet")) return "mainnet";
  return networks[0] ?? null;
}

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
  connectedEmail = null;
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

export async function connect(clientId: string, opts: { silent?: boolean; hint?: string } = {}): Promise<void> {
  if (!clientId) throw new Error("Missing Google Client ID");
  await loadGis();
  const google = (window as any).google;
  if (!google?.accounts?.oauth2) throw new Error("Google Identity Services not available");
  await new Promise<void>((resolve, reject) => {
    const tokenClient = google.accounts.oauth2.initTokenClient({
      ...buildTokenClientConfig(clientId, opts),
      callback: (resp: any) => {
        if (resp.error) {
          reject(new Error(`OAuth error: ${resp.error}`));
          return;
        }
        const token: string = resp.access_token;
        accessToken = token;
        markDriveConfigured();
        // Best-effort: learn the account email to use as a login_hint next time.
        // Never blocks connect success — a failed lookup just means no hint.
        fetchAccountEmail(token)
          .then((email) => {
            if (email) rememberEmail(email);
          })
          .catch(() => {
            /* best-effort email hint; a failed lookup just means no login_hint */
          })
          .finally(() => resolve());
      },
      error_callback: (err: any) => reject(new Error(err?.type || "OAuth token error")),
    });
    tokenClient.requestAccessToken();
  });
}

// ---- Redirect OAuth flow (installed iOS PWA: the GIS popup is blocked) ----

// The registered Authorized redirect URI: the app's own origin (NO trailing slash — Google matches
// redirect URIs by exact string, and the console's origin field rejects a trailing slash, so we
// register the bare origin `https://<host>` and must send exactly that). MUST be added to the OAuth
// client's "Authorized redirect URIs" in the Google Cloud console (see README/PR notes).
function driveRedirectUri(): string {
  return location.origin;
}

function randomState(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

// Begin the full-page OAuth redirect. Navigates AWAY to Google; the token returns in the URL
// fragment on the way back (consumed by completeDriveRedirect on boot). Does not return meaningfully.
export function beginDriveRedirect(clientId: string, hint?: string): void {
  if (!clientId) throw new Error("Missing Google Client ID");
  const state = randomState();
  try {
    sessionStorage.setItem(OAUTH_STATE_KEY, state);
  } catch {
    /* private mode / storage disabled — CSRF check degrades to best-effort; token still valid */
  }
  const url = buildDriveAuthUrl({
    clientId,
    redirectUri: driveRedirectUri(),
    scope: AUTH_SCOPES,
    state,
    loginHint: hint,
  });
  location.assign(url);
}

// Consume an OAuth redirect return from the URL fragment (called once on boot). Stores the token if
// present and the CSRF state matches; kicks off a best-effort email learn. Returns what happened so
// the caller can strip the fragment and surface an error. No-op (ok:false, no error) on a normal load.
export function completeDriveRedirect(hash: string): { ok: boolean; error?: string } {
  const parsed = parseDriveOAuthFragment(hash);
  if (!parsed) return { ok: false };
  let expected: string | null = null;
  try {
    expected = sessionStorage.getItem(OAUTH_STATE_KEY);
    sessionStorage.removeItem(OAUTH_STATE_KEY);
  } catch {
    /* best-effort */
  }
  if (parsed.error) return { ok: false, error: parsed.error };
  if (!parsed.accessToken) return { ok: false };
  // CSRF: only reject on a definite mismatch (both sides present). A missing stored state (lost
  // across the redirect) still accepts — the implicit token is bound to our client + redirect_uri.
  if (expected && parsed.state && parsed.state !== expected) return { ok: false, error: "state_mismatch" };
  accessToken = parsed.accessToken;
  markDriveConfigured();
  fetchAccountEmail(parsed.accessToken)
    .then((email) => {
      if (email) rememberEmail(email);
    })
    .catch(() => {
      /* best-effort email hint */
    });
  return { ok: true };
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

// List which networks have a backup in the app's Drive folder (no decryption needed) — lets
// restore auto-detect the network instead of making the user pre-select it.
export async function listBackupNetworks(): Promise<string[]> {
  const q = encodeURIComponent("name contains 'libre-wallet-backup-'");
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(name)`,
    { method: "GET" }
  );
  const data = await res.json();
  const nets = ((data.files || []) as { name: string }[])
    .map((f) => networkFromBackupFilename(f.name))
    .filter((n): n is string => !!n);
  return Array.from(new Set(nets));
}

async function findBackupFileId(network: string): Promise<string | null> {
  const q = encodeURIComponent(`name='${backupFilename(network)}'`);
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id)`,
    { method: "GET" }
  );
  const data = await res.json();
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

// Thrown when a Drive upload would OVERWRITE a backup that belongs to a DIFFERENT wallet (a
// different seed). This is the iOS-eviction fund-loss guard: after iOS evicts local storage the
// user can land on "Create wallet", generate a fresh seed, and an auto-sync would otherwise
// PATCH-overwrite the old funded wallet's only cloud copy (the filename is fixed per network).
// The caller must NOT overwrite — the user should Restore the existing backup instead.
export class DriveForeignBackupError extends Error {
  readonly code = "DRIVE_FOREIGN_BACKUP";
  constructor(readonly network: string) {
    super(
      `Google Drive already has a backup for a different ${network} wallet. Restore it instead of ` +
        `creating a new wallet — otherwise you'd overwrite (and lose) that wallet's only cloud copy.`,
    );
    this.name = "DriveForeignBackupError";
  }
}
export function isDriveForeignBackupError(e: unknown): boolean {
  return (e as { code?: string })?.code === "DRIVE_FOREIGN_BACKUP";
}

export async function uploadBackup(contents: string, network: string): Promise<void> {
  const existingId = await findBackupFileId(network);
  if (existingId) {
    await driveFetch(
      `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: contents }
    );
  } else {
    const boundary = "libreBackupBoundary";
    const metadata = { name: backupFilename(network), parents: ["appDataFolder"] };
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

export async function downloadBackup(network: string): Promise<string | null> {
  const id = await findBackupFileId(network);
  if (!id) return null;
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${id}?alt=media`,
    { method: "GET" }
  );
  return await res.text();
}

// Delete a single network's backup file. No-op if there's nothing to delete. DELETE returns
// HTTP 204 with an empty body, so we don't read the response.
export async function deleteBackup(network: string): Promise<void> {
  const id = await findBackupFileId(network);
  if (!id) return;
  await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}`, { method: "DELETE" });
}

// Remove EVERY network's backup from the app's private Drive folder. Returns the networks that
// had a backup (for a status message).
export async function deleteAllBackups(): Promise<string[]> {
  const nets = await listBackupNetworks();
  for (const n of nets) await deleteBackup(n);
  return nets;
}
