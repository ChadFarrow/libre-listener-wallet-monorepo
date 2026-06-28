// Google Drive backup client for the example app.
// Google Identity Services (token flow) for OAuth + Drive REST against the private
// `drive.appdata` folder. Stores exactly one encrypted backup file. The access token
// is short-lived and kept only in memory (never persisted).

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
// 'email' lets us read the account address after consent and reuse it as a
// login_hint for silent reconnect on later loads (so the user isn't re-prompted
// every session). Scopes are space-separated for the GIS token client.
const AUTH_SCOPES = `${DRIVE_SCOPE} email`;
const GIS_SRC = "https://accounts.google.com/gsi/client";

let connectedEmail: string | null = null;

/** Email of the connected account, learned from the 'email' scope. Persist this and
 *  feed it back as `hint` on silent reconnect. Null until a connect succeeds. */
export function getConnectedEmail(): string | null {
  return connectedEmail;
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
        // Best-effort: learn the account email to use as a login_hint next time.
        // Never blocks connect success — a failed lookup just means no hint.
        fetchAccountEmail(token)
          .then((email) => {
            if (email) connectedEmail = email;
          })
          .finally(() => resolve());
      },
      error_callback: (err: any) => reject(new Error(err?.type || "OAuth token error")),
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
