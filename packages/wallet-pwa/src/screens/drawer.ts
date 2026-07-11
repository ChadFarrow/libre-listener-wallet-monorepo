import type { AppContext } from "../core/app-context";
import { onControllerEvent } from "../core/events";
import { deleteDiagDb } from "../core/diag-store";
import { isDemoMode, demoState } from "../core/demo-mode";
import { driveConnected, driveConfigured, driveSyncPending } from "../drive-integration";
import { drawerBackupStatus } from "../core/drive-ui";
import { confirmModal } from "../ui/confirm-modal";
import { showScreenFromDrawer, resetToHome } from "../ui/nav";
import { $, setMsg } from "./util";

// Drawer wiring: header status, per-item navigation, and the destructive delete-all flow.
// Items for screens that land in later steps ship hidden in index.html.

export function initDrawer(ctx: AppContext): void {
  const controller = ctx.controller;

  async function refresh(): Promise<void> {
    try {
      const s = await controller.getState();
      $("drawer-status").textContent = `${s.running ? "Node running" : "Node stopped"} · ${s.network}`;
      $("node-dot").classList.toggle("off", !s.running);
      const val = $("d-node-val");
      val.textContent = s.running ? "Running" : "Stopped";
      val.className = `val ${s.running ? "ok" : "warn"}`;
      $("d-channels-val").textContent =
        s.channels != null ? `${s.usableChannels ?? 0}/${s.channels}` : "";
      $("d-peers-val").textContent = s.peers != null ? String(s.peers) : "";
      const bk = drawerBackupStatus({
        demo: isDemoMode(),
        configured: isDemoMode() ? demoState.driveConfigured : driveConfigured(),
        connected: isDemoMode() ? demoState.driveConfigured : driveConnected(),
        running: !!s.running,
        pendingSync: isDemoMode() ? false : driveSyncPending(),
      });
      const bkVal = $("d-backup-val");
      bkVal.textContent = bk.label;
      bkVal.className = `val ${bk.cls}`;
    } catch {
      /* drawer header is cosmetic — never break on a state read */
    }
  }

  function navItem(itemId: string, screenId: string): void {
    $(itemId).addEventListener("click", () => {
      showScreenFromDrawer(screenId);
    });
  }

  // Straight back to the main wallet page, however deep the screen stack is — on desktop the
  // sidebar is permanent and stacked settings screens otherwise need one ← click each.
  $("d-home").addEventListener("click", () => resetToHome());

  navItem("d-node", "screen-node");
  navItem("d-channels", "screen-channels");
  navItem("d-peers", "screen-peers");
  navItem("d-getchannel", "screen-get-channel");
  navItem("d-appconns", "screen-appconns");
  navItem("d-backup", "screen-backup");
  navItem("d-recovery", "screen-recovery");
  navItem("d-sweep", "screen-sweep");
  navItem("d-restore", "screen-restore");
  navItem("d-dev", "screen-dev");

  $("d-delete").addEventListener("click", () => {
    void (async () => {
      const ok = await confirmModal({
        title: "Delete all wallet data?",
        body:
          "This wipes the wallet from this device. Without your seed or a backup, any funds are " +
          "gone forever. Any sats in a live channel are lost.",
        confirmLabel: "Delete everything",
        cancelLabel: "Cancel",
        danger: true,
      });
      if (!ok) return;
      try {
        await controller.resetWallet();
        await deleteDiagDb(); // diagnostics DB is disposable — wipe it with everything else
        // Full clean slate: app-layer localStorage too, then reload — releasing the per-origin
        // node lock so the fresh onboarding can start a node without NODE_ALREADY_RUNNING.
        localStorage.clear();
        location.reload();
      } catch (e) {
        setMsg("node-msg", (e as Error).message, "err");
      }
    })();
  });

  onControllerEvent(() => void refresh());
  void refresh();
}
