// Google Drive REST client against the private `drive.appdata` folder — the extension's port of
// the PWA's `drive-backup.ts` Drive calls. Difference: the access token is passed in per-call
// (the background service worker owns the in-memory token) rather than held in a module global,
// so this stays a pure request layer. Stores exactly one encrypted backup file per network.
//
// The backup file is the SDK's already-encrypted export envelope — the raw seed never reaches
// this layer or the background, only the ciphertext (key-isolation guardrail preserved).

export class DriveReconnectError extends Error {
  constructor() {
    super("Google Drive session expired — reconnect needed");
    this.name = "DriveReconnectError";
  }
}

// One backup file PER NETWORK so a regtest sync can't clobber the mainnet backup. Matches the
// PWA filename exactly (pinned by the storage-contract tests) so a backup made in the app can be
// restored in the extension and vice-versa.
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

async function driveFetch(token: string, url: string, init: RequestInit): Promise<Response> {
  if (!token) throw new DriveReconnectError();
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new DriveReconnectError();
  if (!res.ok) throw new Error(`Drive API error ${res.status}: ${await res.text()}`);
  return res;
}

/** Best-effort account email lookup, used as a `login_hint` for quieter future reconnects. */
export async function fetchAccountEmail(token: string): Promise<string | null> {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.email === "string" ? data.email : null;
  } catch (e) {
    console.warn("[Drive] account email lookup failed:", (e as Error)?.message || e);
    return null;
  }
}

// List which networks have a backup in the app-data folder (no decryption) — lets restore
// auto-detect the network instead of making the user pre-select it.
export async function listBackupNetworks(token: string): Promise<string[]> {
  const q = encodeURIComponent("name contains 'libre-wallet-backup-'");
  const res = await driveFetch(
    token,
    `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(name)`,
    { method: "GET" }
  );
  const data = await res.json();
  const nets = ((data.files || []) as { name: string }[])
    .map((f) => networkFromBackupFilename(f.name))
    .filter((n): n is string => !!n);
  return Array.from(new Set(nets));
}

async function findBackupFileId(token: string, network: string): Promise<string | null> {
  const q = encodeURIComponent(`name='${backupFilename(network)}'`);
  const res = await driveFetch(
    token,
    `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id)`,
    { method: "GET" }
  );
  const data = await res.json();
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

export async function uploadBackup(token: string, contents: string, network: string): Promise<void> {
  const existingId = await findBackupFileId(token, network);
  if (existingId) {
    await driveFetch(
      token,
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
      token,
      `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`,
      { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body }
    );
  }
}

export async function downloadBackup(token: string, network: string): Promise<string | null> {
  const id = await findBackupFileId(token, network);
  if (!id) return null;
  const res = await driveFetch(token, `https://www.googleapis.com/drive/v3/files/${id}?alt=media`, {
    method: "GET",
  });
  return await res.text();
}
