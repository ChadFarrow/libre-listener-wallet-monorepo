import "./style.css";
import { WalletController } from "./wallet-controller";
import type { AppContext } from "./core/app-context";
import { emitControllerEvent, onControllerEvent } from "./core/events";
import { AUTO_START_KEY } from "./core/auto-start";
import { registerServiceWorker, wireInstallPrompt } from "./register-sw";
import { downloadBackupName } from "./core/backup-name";
import { driveConnected, driveBackupNow } from "./drive-integration";
import { initHome } from "./views/home";
import { initSettings } from "./views/settings";

// The single LDK node owner. Its emit callback fans out to any subscribed view.
const controller = new WalletController((event, payload) => emitControllerEvent(event, payload));
const ctx: AppContext = { controller, isRunning: () => controller.isRunning() };

// ---- tab switching ----
function showTab(tab: string): void {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(".tab"))) {
    el.classList.toggle("active", el.dataset.tab === tab);
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(".view"))) {
    el.classList.toggle("active", el.id === `${tab}-view`);
  }
}
for (const el of Array.from(document.querySelectorAll<HTMLElement>(".tab"))) {
  el.addEventListener("click", () => showTab(el.dataset.tab || "home"));
}
// Views ask to switch tabs (e.g. "open settings") via this global.
(window as unknown as { showTab: (t: string) => void }).showTab = showTab;

// ---- local auto-backup file (settings toggle libre_auto_download) ----
const AUTO_DOWNLOAD_KEY = "libre_auto_download";
let autoDlTimer: ReturnType<typeof setTimeout> | undefined;
onControllerEvent((event) => {
  if (event !== "state-changed") return;
  if (localStorage.getItem(AUTO_DOWNLOAD_KEY) !== "1") return;
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
  if (event !== "state-changed") return;
  if (!controller.isRunning() || !driveConnected()) return;
  clearTimeout(driveSyncTimer);
  driveSyncTimer = setTimeout(() => {
    void driveBackupNow(controller).catch((e) => console.warn("[DriveSync] auto-backup failed:", (e as Error)?.message || e));
  }, 5000);
});

// ---- boot ----
registerServiceWorker();
wireInstallPrompt();
initHome(ctx);
initSettings(ctx);

// Auto-start (default on; a stateless non-created-here seed is a silent skip in the controller).
void controller.autoStart(localStorage.getItem(AUTO_START_KEY)).finally(() => emitControllerEvent("state-changed"));
