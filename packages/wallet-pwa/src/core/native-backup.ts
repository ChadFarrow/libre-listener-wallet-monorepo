// SAF-based off-device backup for the native Android APK (see packages/android-app
// LibreBackupStoragePlugin.kt). Play-Services-FREE: the user picks a folder ONCE via the OS
// (local storage, or Google Drive if installed) and we write the SAME encrypted backup envelope the
// Drive path uses. This mirrors the drive-integration.ts surface (configured / backup-now / restore /
// networks + the foreign-backup guard) so the Cloud Backup screen, auto-backup, and restore treat it
// identically — the only difference is where the bytes land. No-op / unavailable in a plain PWA.

import { isNativeApp } from "./native-bridge";
import type { WalletController } from "../wallet-controller";
import {
  backupFilename,
  networkFromBackupFilename,
  pickRestoreNetwork,
  DriveForeignBackupError,
} from "../drive-backup";

const PLUGIN_NAME = "LibreBackupStorage";
// Persisted tree URI of the folder the user picked (SAF grants a persistable permission to it).
const TREE_URI_KEY = "libre_saf_tree_uri";

export interface BackupStoragePlugin {
  detectTargets(): Promise<{ local: boolean; gdrive: boolean }>;
  pickFolder(opts?: { initialUri?: string }): Promise<{ treeUri: string }>;
  writeFile(opts: { treeUri: string; name: string; contents: string }): Promise<void>;
  readFile(opts: { treeUri: string; name: string }): Promise<{ contents: string }>;
  listBackups(opts: { treeUri: string }): Promise<{ files: string[] }>;
}

function plugin(): BackupStoragePlugin | null {
  const p = (globalThis as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
    ?.Plugins?.[PLUGIN_NAME] as Partial<BackupStoragePlugin> | undefined;
  return p && typeof p.pickFolder === "function" ? (p as BackupStoragePlugin) : null;
}

// True only inside the native wrapper AND when the backup-storage plugin is registered.
export function nativeBackupAvailable(): boolean {
  return isNativeApp() && plugin() !== null;
}

// Which targets the device can back up to right now: local always; Google Drive only if its app /
// DocumentsProvider is installed — so the UI never shows a dead Drive option.
export async function detectBackupTargets(): Promise<{ local: boolean; gdrive: boolean }> {
  const p = plugin();
  if (!p) return { local: false, gdrive: false };
  try {
    return await p.detectTargets();
  } catch {
    return { local: true, gdrive: false };
  }
}

function treeUri(): string | null {
  return localStorage.getItem(TREE_URI_KEY);
}

// Has the user picked a backup folder yet (the native equivalent of driveConfigured()).
export function backupFolderConfigured(): boolean {
  return !!treeUri();
}

// A display label inferred from the chosen folder's tree URI (Drive URIs carry the Drive authority).
export function backupTargetLabel(): string {
  const uri = treeUri();
  if (!uri) return "";
  return /com\.google\.android\.apps\.docs/i.test(uri) ? "Google Drive" : "Local storage";
}

// Launch the system folder picker; persist the chosen folder's tree URI. `initialUri` (optional)
// hints where the picker opens (e.g. Drive's root vs local storage).
export async function chooseBackupFolder(opts?: { initialUri?: string }): Promise<{ label: string }> {
  const p = plugin();
  if (!p) throw new Error("Backup storage is not available.");
  const { treeUri: uri } = await p.pickFolder(opts);
  if (!uri) throw new Error("No folder was chosen.");
  localStorage.setItem(TREE_URI_KEY, uri);
  return { label: backupTargetLabel() };
}

// Forget the chosen folder (e.g. "disconnect" / pick a different one).
export function clearBackupFolder(): void {
  localStorage.removeItem(TREE_URI_KEY);
}

// Write the current encrypted backup envelope into the chosen folder. Mirrors driveBackupNow,
// including the fund-safety foreign-backup guard: never overwrite a backup that belongs to a
// DIFFERENT wallet (a fresh seed after a wipe must not clobber the funded wallet's only copy).
export async function nativeBackupNow(controller: WalletController): Promise<{ network: string }> {
  const p = plugin();
  const uri = treeUri();
  if (!p || !uri) throw new Error("Choose a backup folder first.");
  const envelope = await controller.exportBackup();
  const { network } = await controller.getState();
  const net = network || "mainnet";
  const name = backupFilename(net);
  let existing: string | null = null;
  try {
    existing = (await p.readFile({ treeUri: uri, name }))?.contents || null;
  } catch {
    existing = null; // no existing file → first backup
  }
  if (existing && !(await controller.backupIsOurs(existing))) {
    throw new DriveForeignBackupError(net);
  }
  await p.writeFile({ treeUri: uri, name, contents: envelope });
  return { network: net };
}

// Which networks have a backup in the chosen folder (for restore + auto-detect).
export async function nativeBackupNetworks(): Promise<string[]> {
  const p = plugin();
  const uri = treeUri();
  if (!p || !uri) return [];
  try {
    const { files } = await p.listBackups({ treeUri: uri });
    return Array.from(
      new Set(files.map(networkFromBackupFilename).filter((n): n is string => !!n)),
    );
  } catch {
    return [];
  }
}

// Read the backup from the chosen folder (auto-detecting the network) and restore it. Mirrors
// driveRestore.
export async function nativeRestore(controller: WalletController, secret: string): Promise<void> {
  const p = plugin();
  const uri = treeUri();
  if (!p || !uri) throw new Error("Choose a backup folder first.");
  const network = pickRestoreNetwork(await nativeBackupNetworks());
  if (!network) throw new Error("No backup found in the chosen folder.");
  const { contents } = await p.readFile({ treeUri: uri, name: backupFilename(network) });
  if (!contents) throw new Error(`No backup file found for ${network}.`);
  await controller.restoreWallet(contents, secret);
}
