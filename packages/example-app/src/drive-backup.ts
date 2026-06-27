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
