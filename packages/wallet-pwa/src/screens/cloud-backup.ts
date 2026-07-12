import type { AppContext } from "../core/app-context";
import { onControllerEvent, emitControllerEvent } from "../core/events";
import { setSeedBackedUp } from "../core/onboarding";
import { downloadBackupName } from "../core/backup-name";
import { isMobileUa } from "../core/backup-policy";
import { isDemoMode, demoState } from "../core/demo-mode";
import {
  driveConnected,
  driveConfigured,
  rememberedEmail,
  ensureDriveConnected,
  driveBackupNow,
  driveDeleteBackups,
} from "../drive-integration";
import {
  nativeBackupAvailable,
  backupFolderConfigured,
  backupTargetLabel,
  chooseBackupFolder,
  nativeBackupNow,
  detectBackupTargets,
} from "../core/native-backup";
import { cloudBackupButtons } from "../core/drive-ui";
import { guardedClick } from "../core/ui-helpers";
import { confirmModal } from "../ui/confirm-modal";
import { registerScreen, currentScreen } from "../ui/nav";
import { $, show, setMsg } from "./util";

const AUTO_DOWNLOAD_KEY = "libre_auto_download";

export function initCloudBackupScreen(ctx: AppContext): void {
  const controller = ctx.controller;

  // Any real backup action satisfies the "seed backed up" marker (the user demonstrably has a copy).
  async function markSeedBackedUp(): Promise<void> {
    try {
      const { network } = await controller.getState();
      if (network) {
        setSeedBackedUp(network);
        emitControllerEvent("state-changed");
      }
    } catch {
      /* best-effort */
    }
  }

  // Native APK: back up to a chosen SAF folder (local or Google Drive) instead of a Drive account.
  // Repurposes the Drive controls — "Connect Drive" → "Choose folder", "Back up now" → SAF write.
  async function refreshNative(): Promise<void> {
    const configured = backupFolderConfigured();
    const targets = await detectBackupTargets();
    const state = $("backup-drive-state");
    state.textContent = configured ? `${backupTargetLabel()} ✓` : "Not set up";
    state.style.color = configured ? "var(--accent)" : "var(--warn)";
    $("backup-account").textContent = targets.gdrive ? "Local storage or Google Drive" : "Local storage";
    const connectBtn = $("drive-connect");
    connectBtn.textContent = configured ? "Change folder" : "Choose backup folder";
    connectBtn.className = configured ? "btn-ghost" : "btn-primary";
    show(connectBtn, true);
    const backupNow = $("drive-backup-now") as HTMLButtonElement;
    backupNow.textContent = "Back up now";
    backupNow.className = configured ? "btn-primary" : "btn-ghost";
    backupNow.disabled = !ctx.isRunning() || !configured;
    ($("export") as HTMLButtonElement).disabled = !ctx.isRunning();
    show("auto-download-row", false);
    show("drive-delete", false);
  }

  function refresh(): void {
    if (nativeBackupAvailable()) {
      void refreshNative();
      return;
    }
    if (isDemoMode()) {
      const dv = cloudBackupButtons(demoState.driveConfigured, demoState.driveConfigured);
      $("backup-drive-state").textContent = demoState.driveConfigured ? "Connected (demo)" : "Not connected";
      $("backup-account").textContent = demoState.driveConfigured ? "demo@example.com" : "—";
      const cb = $("drive-connect");
      cb.textContent = dv.connect.label;
      cb.className = dv.connect.primary ? "btn-primary" : "btn-ghost";
      show(cb, dv.connect.show);
      ($("drive-backup-now") as HTMLElement).className = dv.backupNowPrimary ? "btn-primary" : "btn-ghost";
      show("auto-download-row", false);
      return;
    }
    const connected = driveConnected();
    const email = rememberedEmail();
    const state = $("backup-drive-state");
    state.textContent = connected ? "Connected ✓ · auto-syncing" : email ? "Reconnect needed" : "Not connected";
    state.style.color = connected ? "var(--accent)" : email ? "var(--warn)" : "";
    $("backup-account").textContent = email || "—";
    // When connected, "Back up now" is the primary (green) action and "Reconnect" drops to a quiet
    // secondary — a big green Reconnect on an already-connected screen reads as "something's wrong".
    const view = cloudBackupButtons(connected, !!email);
    const connectBtn = $("drive-connect");
    const backupNow = $("drive-backup-now") as HTMLButtonElement;
    connectBtn.textContent = view.connect.label;
    connectBtn.className = view.connect.primary ? "btn-primary" : "btn-ghost";
    show(connectBtn, view.connect.show); // hidden once connected — no "Switch account" clutter
    backupNow.className = view.backupNowPrimary ? "btn-primary" : "btn-ghost";
    ($("export") as HTMLButtonElement).disabled = !ctx.isRunning();
    backupNow.disabled = !ctx.isRunning();
    // Drive replaces the local auto-download once configured, and mobile never auto-downloads
    // (core/backup-policy.ts) — reflect the policy so the toggle can't promise what won't run.
    if (isMobileUa(navigator.userAgent)) {
      show("auto-download-row", false);
    } else {
      const auto = $<HTMLInputElement>("auto-download");
      auto.checked = localStorage.getItem(AUTO_DOWNLOAD_KEY) === "1";
      auto.disabled = driveConfigured();
      $("auto-download-row").style.opacity = driveConfigured() ? "0.5" : "";
    }
  }

  $("drive-connect").addEventListener("click", () => {
    void (async () => {
      if (nativeBackupAvailable()) {
        setMsg("backup-msg", "Opening folder picker…");
        try {
          const { label } = await chooseBackupFolder();
          refresh();
          setMsg("backup-msg", `Backing up to ${label}. Tap “Back up now” to save a copy.`, "ok");
          void markSeedBackedUp();
        } catch (e) {
          setMsg("backup-msg", (e as Error).message, "err");
        }
        return;
      }
      if (isDemoMode()) {
        demoState.driveConfigured = true;
        refresh();
        setMsg("backup-msg", "Drive connected (demo)", "ok");
        return;
      }
      setMsg("backup-msg", "Opening Google sign-in…");
      try {
        await ensureDriveConnected();
        setMsg("backup-msg", "Drive connected — backups now sync automatically", "ok");
        refresh();
        void markSeedBackedUp();
        if (ctx.isRunning())
          void driveBackupNow(controller).catch((e) =>
            console.warn("[Drive] initial backup failed:", (e as Error)?.message || e),
          );
        emitControllerEvent("state-changed");
      } catch (e) {
        setMsg("backup-msg", (e as Error).message, "err");
      }
    })();
  });

  $("drive-backup-now").addEventListener("click", () => {
    void (async () => {
      if (nativeBackupAvailable()) {
        setMsg("backup-msg", `Backing up to ${backupTargetLabel()}…`);
        try {
          const { network } = await nativeBackupNow(controller);
          setMsg("backup-msg", `Backed up (${network}) to ${backupTargetLabel()}`, "ok");
          void markSeedBackedUp();
        } catch (e) {
          setMsg("backup-msg", (e as Error).message, "err");
        }
        return;
      }
      setMsg("backup-msg", "Backing up to Drive…");
      try {
        const { network } = await driveBackupNow(controller);
        setMsg("backup-msg", `Backed up (${network}) to Google Drive`, "ok");
        void markSeedBackedUp();
      } catch (e) {
        setMsg("backup-msg", (e as Error).message, "err");
      }
    })();
  });

  $("export").addEventListener("click", () => {
    void (async () => {
      setMsg("backup-msg", "Preparing backup…");
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
        setMsg("backup-msg", `Downloaded ${name}. Store it safely.`, "ok");
        void markSeedBackedUp();
      } catch (e) {
        setMsg("backup-msg", (e as Error).message, "err");
      }
    })();
  });

  $("auto-download").addEventListener("change", (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    localStorage.setItem(AUTO_DOWNLOAD_KEY, enabled ? "1" : "0");
    setMsg("backup-msg", enabled ? "Auto-backup on — a dated file downloads when your wallet changes." : "Auto-backup off.", "ok");
  });

  // guardedClick: single-flight so a double-tap can't fire two deletes. Requires the node
  // stopped: auto-sync only runs while running, so a stopped node keeps the delete deleted.
  guardedClick($<HTMLButtonElement>("drive-delete"), async () => {
    if (ctx.isRunning()) {
      setMsg("backup-msg", "Stop the node first, then delete the Drive backup.", "err");
      return;
    }
    const ok = await confirmModal({
      title: "Delete Google Drive backup?",
      body:
        "This permanently removes your encrypted backup from Google Drive. If you have a channel and " +
        "no other backup, its funds become UNRECOVERABLE. Your local wallet is not affected.",
      confirmLabel: "Delete backup",
      danger: true,
    });
    if (!ok) return;
    setMsg("backup-msg", "Deleting Drive backup…");
    try {
      const removed = await driveDeleteBackups();
      setMsg("backup-msg", removed.length ? `Deleted Drive backup (${removed.join(", ")}).` : "No Drive backup found to delete.", "ok");
      refresh();
    } catch (e) {
      setMsg("backup-msg", (e as Error).message, "err");
    }
  });

  registerScreen("screen-backup", { onShow: () => refresh() });
  onControllerEvent(() => {
    if (currentScreen() === "screen-backup") refresh();
  });
}
