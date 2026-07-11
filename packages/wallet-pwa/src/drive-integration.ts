// Thin glue between the Drive REST module (drive-backup.ts) and the WalletController, shared by the
// home (restore) and settings (connect / backup-now) views. Keeps the GIS token flow and the
// remembered-account hint in one place.
import {
  connect as driveConnect,
  isConnected,
  getConnectedEmail,
  uploadBackup,
  downloadBackup,
  listBackupNetworks,
  pickRestoreNetwork,
  deleteAllBackups,
  DriveForeignBackupError,
} from "./drive-backup";
import type { WalletController } from "./wallet-controller";
import { isDemoMode } from "./core/demo-mode";

const CLIENT_ID_KEY = "libre_google_client_id";
const HINT_KEY = "libre_drive_hint";

// Baked build var (same as the extension/PWA ship) with an optional user override.
export function googleClientId(): string {
  return (localStorage.getItem(CLIENT_ID_KEY) || import.meta.env.VITE_GOOGLE_CLIENT_ID || "").trim();
}
export function setGoogleClientId(id: string): void {
  if (id.trim()) localStorage.setItem(CLIENT_ID_KEY, id.trim());
  else localStorage.removeItem(CLIENT_ID_KEY);
}

export function driveConnected(): boolean {
  return isConnected();
}
export function rememberedEmail(): string | null {
  return getConnectedEmail() || localStorage.getItem(HINT_KEY);
}
// Persistent "cloud backup has been set up" signal for the onboarding gate. Uses the remembered
// account (set the first time Drive connects) rather than the in-memory token, so the mandatory
// backup step stays satisfied across reloads — the token silently reconnects on first interaction.
export function driveConfigured(): boolean {
  return !!rememberedEmail();
}

export async function ensureDriveConnected(opts: { silent?: boolean } = {}): Promise<void> {
  // Demo mode must NEVER reach Google: this is the single choke point every Drive flow
  // (connect, backup-now, delete, restore) funnels through. Demo screens simulate their own
  // "connected" state; anything that lands here in demo gets a clean error, not a sign-in.
  if (isDemoMode()) throw new Error("Google Drive isn't available in demo mode.");
  if (isConnected()) return;
  const clientId = googleClientId();
  if (!clientId) throw new Error("No Google Client ID configured — set one under Backup → advanced.");
  const hint = localStorage.getItem(HINT_KEY) || undefined;
  await driveConnect(clientId, { silent: opts.silent, hint });
  const email = getConnectedEmail();
  if (email) localStorage.setItem(HINT_KEY, email);
}

// Remove every network's encrypted backup from Google Drive. Ensures a live token first (it's
// in-memory, so it's null after a page reload). Returns which networks were removed.
export async function driveDeleteBackups(): Promise<string[]> {
  await ensureDriveConnected();
  return deleteAllBackups();
}

// Pending-sync flag behind the drawer's "Synced ✓ / Syncing…" chip: set the moment a wallet
// change arms the auto-sync debounce (main.ts), cleared only when an upload actually lands —
// so a failed upload keeps reading "Syncing…" instead of falsely claiming "Synced".
// In-memory + display-only; never gates a backup.
let pendingSync = false;
export function driveSyncPending(): boolean {
  return pendingSync;
}
export function markDriveSyncPending(): void {
  pendingSync = true;
}

// In-memory "this network's Drive backup is confirmed ours (this seed)" cache, so the ownership
// check below (a Drive download + decrypt) runs once per wallet per session instead of on every
// 5s-debounced auto-sync. Keyed by seed so a restore to a different wallet re-checks. Never
// persisted or logged.
const confirmedOwnBackup = new Map<string /*network*/, string /*seedHex*/>();

export async function driveBackupNow(controller: WalletController): Promise<{ network: string }> {
  await ensureDriveConnected();
  const envelope = await controller.exportBackup();
  const { network } = await controller.getState();
  const net = network || "mainnet";
  // FUND-SAFETY (iOS-eviction guard): never PATCH-overwrite a Drive backup that belongs to a
  // DIFFERENT wallet. If Drive already holds a backup for this network that does NOT decrypt with
  // our current seed, refuse and let the caller offer Restore instead of destroying it.
  const { seedHex } = await controller.getSeed();
  if (confirmedOwnBackup.get(net) !== seedHex) {
    const existing = await downloadBackup(net);
    if (existing && !(await controller.backupIsOurs(existing))) {
      throw new DriveForeignBackupError(net);
    }
    confirmedOwnBackup.set(net, seedHex);
  }
  await uploadBackup(envelope, net);
  // Backup landed — the drawer chip may flip "Syncing…" → "Synced ✓". Manual "Back up now"
  // clears any pending auto-sync debt too (the uploaded state is the current state).
  pendingSync = false;
  return { network: net };
}

// Fetch the backup from Drive (auto-detecting the network) and restore it with the given secret.
export async function driveRestore(controller: WalletController, secret: string): Promise<void> {
  await ensureDriveConnected();
  const networks = await listBackupNetworks();
  const network = pickRestoreNetwork(networks);
  if (!network) throw new Error("No backup found in Google Drive for this account.");
  const envelope = await downloadBackup(network);
  if (!envelope) throw new Error(`No backup file found for ${network}.`);
  await controller.restoreWallet(envelope, secret);
}
