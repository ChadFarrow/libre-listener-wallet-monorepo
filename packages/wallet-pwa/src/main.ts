import "./style.css";
import { installDiagTap } from "./core/diag-tap";
import { WalletController } from "./wallet-controller";
import { DemoController } from "./core/demo-controller";
import { enterDemoFromUrl, isDemoMode, exitDemo, applyDemoManifest } from "./core/demo-mode";
import type { AppContext } from "./core/app-context";
import { emitControllerEvent, onControllerEvent } from "./core/events";
import { AUTO_START_KEY } from "./core/auto-start";
import { registerServiceWorker, wireInstallPrompt } from "./register-sw";
import { downloadBackupName } from "./core/backup-name";
import { isMobileUa, shouldAutoDownload, shouldDriveAutoSync } from "./core/backup-policy";
import { driveConnected, driveConfigured, driveBackupNow, ensureDriveConnected, rememberedEmail, markDriveSyncPending } from "./drive-integration";
import { shouldArmGestureReconnect } from "./core/drive-ui";
import { shouldRefreshOnVisible } from "./core/resume-refresh";
import { refreshPushRegistration } from "./web-push";
import { createKeepAliveForPlatform, isNativeApp } from "./core/native-bridge";
import { shouldKeepAlive, keepAliveEnabled } from "./core/keep-alive";
import { installNoZoom } from "./core/no-zoom";
import { initScreens } from "./screens";

// Native-app feel: block every zoom gesture (pinch, ctrl+wheel) the viewport meta can't cover.
// The viewport meta + `touch-action: manipulation` (style.css) handle standalone PWAs and
// double-tap; this covers the iOS Safari tab + desktop trackpad cases.
installNoZoom();

// Demo mode (?demo): a fake in-memory controller — no real node, storage, or network — so the
// UI can be exercised end-to-end with zero setup. The badge + drawer exit make it unmistakable.
enterDemoFromUrl(location.search, location.hash);

// Always-on diagnostics: wrap console + lifecycle events BEFORE anything logs.
// Local-only ring buffer; export lives in Developer settings. Spec: 2026-07-11-diag-log-design.md.
installDiagTap();

// The single LDK node owner (or its demo stand-in). Its emit callback fans out to any screen.
const controller = isDemoMode()
  ? (new DemoController((event, payload) => emitControllerEvent(event, payload)) as unknown as WalletController)
  : new WalletController((event, payload) => emitControllerEvent(event, payload));
// Native wrapper (Capacitor Android) → a foreground service holds the node alive in the background;
// plain browser/PWA → the inaudible audio keep-alive. Same KeepAlive interface either way.
const keepAlive = createKeepAliveForPlatform();
const ctx: AppContext = { controller, isRunning: () => controller.isRunning(), keepAlive };

// ---- Background keep-alive (silent audio) ----
// When enabled (developer toggle, default off) keep the node's page alive in the background so NWC
// boosts settle in real time. Driven off run-state: start while running+enabled, stop otherwise.
// Skipped in demo (no real node). play() may need a gesture — the manager arms a first-gesture retry.
if (!isDemoMode()) {
  onControllerEvent(() => {
    if (shouldKeepAlive({ enabled: keepAliveEnabled(), running: controller.isRunning(), demo: false })) keepAlive.start();
    else keepAlive.stop();
  });
  // iOS blocks audio.play() outside a user gesture, so keep-alive can't self-start when the node
  // comes up from a non-gesture path (auto-start, or the controller event a beat after the tap).
  // Prime the audio element on the user's FIRST tap anywhere (e.g. tapping "Start node") so one tap
  // activates it, instead of needing a tap at the exact moment the node is ready. Stays armed until
  // the element is actually playing. Native wrapper has no autoplay gate (foreground service, not
  // audio), so skip the gesture arming there.
  if (keepAliveEnabled() && !isNativeApp()) {
    const prime = () => {
      keepAlive.unlock();
      if (keepAlive.isActive()) {
        window.removeEventListener("pointerdown", prime);
        window.removeEventListener("keydown", prime);
      }
    };
    window.addEventListener("pointerdown", prime);
    window.addEventListener("keydown", prime);
  }
}

if (isDemoMode()) {
  // Swap the manifest so an "Add to Home Screen" from here installs a demo PWA that relaunches
  // into ?demo (iOS drops the query otherwise → the install boots the real app + real sign-in).
  applyDemoManifest();
  document.getElementById("demo-badge")?.classList.remove("hidden");
  const exitBtn = document.getElementById("d-exit-demo");
  exitBtn?.classList.remove("hidden");
  exitBtn?.addEventListener("click", () => exitDemo());
}

// ---- Foreground-resume peer refresh (iOS zombie-socket fix) ----
// iOS freezes a backgrounded PWA and can kill the bridge socket without an onclose, leaving a
// half-open "zombie" connection: on return the wallet looks connected (balance/pill fine) but a
// send stalls for ~10-20s until LDK's ping-timeout heals it. On becoming visible we proactively
// drop + redial peers to collapse that window, and refresh the UI. Skipped in demo (no real peers).
if (!isDemoMode()) {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (shouldRefreshOnVisible(document.visibilityState, controller.isRunning())) {
      // Running: drop + redial peers in case iOS killed the bridge socket while frozen.
      void controller
        .refreshPeerConnections()
        .catch((e) => console.warn("[Resume] peer refresh failed:", (e as Error)?.message || e));
      // iOS can also drop the push subscription while frozen — re-register it on resume so offline
      // wake keeps working (silent + best-effort; no-op unless wake was enabled). Native wrapper
      // doesn't use web push (a foreground service holds the node alive; GrapheneOS has no FCM).
      if (!isNativeApp()) void refreshPushRegistration(ctx);
      // The keep-alive tone is often paused while backgrounded (another app grabbed audio focus, or
      // the OS suspended us). Re-arm it now we're foreground again so it's holding the page for the
      // NEXT trip to the background. No-op if it's already playing; harmless while foreground.
      if (keepAliveEnabled() && controller.isRunning()) keepAlive.start();
    } else {
      // Stopped on a stale single-node lock (a frozen sibling page iOS just reaped on resume) —
      // re-attempt the start instead of leaving a latched "already running" pill. No-op otherwise.
      void controller
        .retryStartIfLocked()
        .catch((e) => console.warn("[Resume] start retry failed:", (e as Error)?.message || e));
    }
    emitControllerEvent("state-changed");
  });
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
// — AND a newly-learned peer address (connectPeer + the restore/auto-start dial both emit
// "state-changed") — is always recoverable. Peer addresses now ride along in the backup, so this is
// what makes "enter seed + sign into Drive → everything reconnects" hands-off: no manual "Back up
// now". Only runs when a live token exists; a fresh launch silently reconnects on the user's first
// interaction (drive-ui), after which the next state change syncs. Never prompts on its own.
let driveSyncTimer: ReturnType<typeof setTimeout> | undefined;
onControllerEvent((event) => {
  if (!shouldDriveAutoSync({ event, demo: isDemoMode(), running: controller.isRunning(), driveConnected: driveConnected() })) return;
  // Changes are now ahead of the Drive copy — flip the drawer chip to "Syncing…" until the
  // upload lands (driveBackupNow clears the flag on success).
  markDriveSyncPending();
  clearTimeout(driveSyncTimer);
  driveSyncTimer = setTimeout(() => {
    void driveBackupNow(controller)
      .catch((e) => console.warn("[DriveSync] auto-backup failed:", (e as Error)?.message || e))
      // "drive-sync" (not "state-changed" — that would re-arm this debounce forever) so the
      // drawer re-reads driveSyncPending() and flips Syncing… → Synced ✓.
      .finally(() => emitControllerEvent("drive-sync"));
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

// ---- Offline-wake push re-registration (iOS drops subscriptions silently) ----
// iOS invalidates a PWA's push subscription over time; once the gateway 410s and deletes the stale
// row, this device stops getting wake notifications until it re-registers. So re-register on every
// node start-transition (covers cold launch + a manual restart). refreshPushRegistration is silent +
// best-effort and no-ops unless the user actually enabled wake, so this is safe to fire each time.
// Skipped in the native wrapper (foreground service replaces web push; GrapheneOS has no FCM).
if (!isDemoMode() && !isNativeApp()) {
  let pushWasRunning = false;
  onControllerEvent(() => {
    const running = controller.isRunning();
    if (running && !pushWasRunning) {
      void refreshPushRegistration(ctx);
    }
    pushWasRunning = running;
  });
}

// ---- boot ----
registerServiceWorker();
wireInstallPrompt();
initScreens(ctx);

// Auto-start (default on; a stateless non-created-here seed is a silent skip in the controller).
void controller.autoStart(localStorage.getItem(AUTO_START_KEY)).finally(() => emitControllerEvent("state-changed"));
