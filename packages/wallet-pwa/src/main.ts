import "./style.css";
import { WalletController } from "./wallet-controller";
import { DemoController } from "./core/demo-controller";
import { enterDemoFromUrl, isDemoMode, exitDemo, applyDemoManifest } from "./core/demo-mode";
import type { AppContext } from "./core/app-context";
import { emitControllerEvent, onControllerEvent } from "./core/events";
import { AUTO_START_KEY } from "./core/auto-start";
import { registerServiceWorker, wireInstallPrompt } from "./register-sw";
import { downloadBackupName } from "./core/backup-name";
import { isMobileUa, shouldAutoDownload } from "./core/backup-policy";
import { driveConnected, driveConfigured, driveBackupNow, ensureDriveConnected, rememberedEmail } from "./drive-integration";
import { shouldArmGestureReconnect } from "./core/drive-ui";
import { initScreens } from "./screens";

// Demo mode (?demo): a fake in-memory controller — no real node, storage, or network — so the
// UI can be exercised end-to-end with zero setup. The badge + drawer exit make it unmistakable.
enterDemoFromUrl(location.search);

// The single LDK node owner (or its demo stand-in). Its emit callback fans out to any screen.
const controller = isDemoMode()
  ? (new DemoController((event, payload) => emitControllerEvent(event, payload)) as unknown as WalletController)
  : new WalletController((event, payload) => emitControllerEvent(event, payload));
const ctx: AppContext = { controller, isRunning: () => controller.isRunning() };

if (isDemoMode()) {
  // Swap the manifest so an "Add to Home Screen" from here installs a demo PWA that relaunches
  // into ?demo (iOS drops the query otherwise → the install boots the real app + real sign-in).
  applyDemoManifest();
  document.getElementById("demo-badge")?.classList.remove("hidden");
  const exitBtn = document.getElementById("d-exit-demo");
  exitBtn?.classList.remove("hidden");
  exitBtn?.addEventListener("click", () => exitDemo());
}

// ---- local auto-backup file (developer-settings toggle libre_auto_download) ----
// Desktop-only fallback: once Google Drive is configured it takes over entirely, and mobile
// never auto-downloads (see core/backup-policy.ts).
const AUTO_DOWNLOAD_KEY = "libre_auto_download";
let autoDlTimer: ReturnType<typeof setTimeout> | undefined;
onControllerEvent((event) => {
  if (isDemoMode()) return; // demo has no real backups — and must never touch Drive/files
  if (event !== "state-changed") return;
  if (
    !shouldAutoDownload({
      toggleOn: localStorage.getItem(AUTO_DOWNLOAD_KEY) === "1",
      driveConfigured: driveConfigured(),
      mobile: isMobileUa(navigator.userAgent),
    })
  )
    return;
  if (!controller.isRunning()) return;
  clearTimeout(autoDlTimer);
  autoDlTimer = setTimeout(() => {
    void (async () => {
      try {
        const env = await controller.exportBackup();
        const { network } = await controller.getState();
        const name = downloadBackupName(network || "mainnet", env, new Date());
        const url = URL.createObjectURL(new Blob([env], { type: "application/json" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      } catch (e) {
        console.warn("[AutoBackup] failed:", (e as Error)?.message || e);
      }
    })();
  }, 8000);
});

// ---- Google Drive auto-sync (debounced on every state change) ----
// Once Drive is connected, keep the encrypted backup current automatically so a newly opened channel
// is always recoverable — the whole reason cloud backup is mandatory before getting a channel. Only
// runs when a live token exists; a fresh launch silently reconnects on the user's first interaction
// (drive-ui), after which the next state change syncs. Never prompts on its own.
let driveSyncTimer: ReturnType<typeof setTimeout> | undefined;
onControllerEvent((event) => {
  if (isDemoMode()) return;
  if (event !== "state-changed") return;
  if (!controller.isRunning() || !driveConnected()) return;
  clearTimeout(driveSyncTimer);
  driveSyncTimer = setTimeout(() => {
    void driveBackupNow(controller).catch((e) => console.warn("[DriveSync] auto-backup failed:", (e as Error)?.message || e));
  }, 5000);
});

// ---- Drive silent reconnect on first interaction ----
// The Drive token is in-memory only, so every reload starts disconnected. GIS token requests
// need a user gesture (a page-load attempt dies with popup_failed_to_open), so when we have a
// remembered account but no live token, retry a SILENT reconnect on the user's first
// pointer/key gesture — no popup, no dedicated Reconnect click; the next state change then
// auto-syncs.
function armDriveGestureReconnect(): void {
  // Demo must NEVER reach Google — the real wallet's remembered Drive account lives in this
  // origin's localStorage, so the silent reconnect would fire a real sign-in from a demo tap.
  if (isDemoMode()) return;
  if (!shouldArmGestureReconnect(driveConnected(), rememberedEmail())) return;
  const onFirstGesture = () => {
    window.removeEventListener("pointerdown", onFirstGesture);
    window.removeEventListener("keydown", onFirstGesture);
    if (driveConnected()) return;
    void (async () => {
      try {
        await ensureDriveConnected({ silent: true });
        console.log("[Drive] silently reconnected on first interaction");
        emitControllerEvent("state-changed");
      } catch (e) {
        console.warn("[Drive] silent reconnect failed:", (e as Error)?.message || e);
      }
    })();
  };
  window.addEventListener("pointerdown", onFirstGesture);
  window.addEventListener("keydown", onFirstGesture);
}
armDriveGestureReconnect();

// ---- boot ----
registerServiceWorker();
wireInstallPrompt();
initScreens(ctx);

// Auto-start (default on; a stateless non-created-here seed is a silent skip in the controller).
void controller.autoStart(localStorage.getItem(AUTO_START_KEY)).finally(() => emitControllerEvent("state-changed"));
