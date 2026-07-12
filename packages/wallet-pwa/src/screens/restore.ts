import type { AppContext } from "../core/app-context";
import { onControllerEvent } from "../core/events";
import { isNodeAlreadyRunningError } from "@libre/shared";
import { setSeedBackedUp } from "../core/onboarding";
import { resolveSeedInput } from "../core/seed-input";
import { guardedClick } from "../core/ui-helpers";
import { driveRestore } from "../drive-integration";
import { nativeBackupAvailable, nativeRestore, chooseBackupFolder, backupFolderConfigured } from "../core/native-backup";
import { confirmModal } from "../ui/confirm-modal";
import { registerScreen, showScreen, currentScreen, resetToHome } from "../ui/nav";
import { $, setMsg } from "./util";

// Latch set when start() throws a channel-state regression: a wallet EXISTS in that state, so
// every ordinary refresh would route to home — the latch keeps forcing this screen until a
// successful restore (or start) clears it.
let needsRestore = false;

const REGRESSION_MSG =
  "This wallet's channel state is behind what it durably reached — starting now would " +
  "force-close your channels. Restore from your latest backup to continue.";

export function forceRestoreScreen(): void {
  needsRestore = true;
  showScreen("screen-restore");
  setMsg("restore-msg", REGRESSION_MSG, "err");
}

export function clearRestoreLatch(): void {
  needsRestore = false;
}

export function initRestoreScreen(ctx: AppContext): void {
  const controller = ctx.controller;

  // A successful restore means the user demonstrably holds their seed/backup — tick the marker.
  async function markBackedUp(): Promise<void> {
    const st = await controller.getState().catch(() => null);
    if (st) setSeedBackedUp(st.network);
  }

  function done(okText: string): void {
    clearRestoreLatch();
    setMsg("restore-msg", okText, "ok");
    void markBackedUp().then(() => resetToHome());
  }

  function fail(e: unknown): void {
    if (isNodeAlreadyRunningError(e)) {
      setMsg("restore-msg", "This wallet is already running in another tab or window — close it and try again.", "err");
      return;
    }
    setMsg("restore-msg", (e as Error).message, "err");
  }

  const secret = () => $<HTMLInputElement>("restore-secret").value.trim();

  $("restore-drive").addEventListener("click", () => {
    void (async () => {
      if (!secret()) {
        setMsg("restore-msg", "Enter your recovery seed first.", "err");
        return;
      }
      // Native APK: restore from the chosen SAF folder (Drive sign-in is blocked in the WebView).
      // If no folder is chosen yet, open the picker first, then read the backup from it.
      if (nativeBackupAvailable()) {
        setMsg("restore-msg", "Reading backup from your folder…");
        try {
          if (!backupFolderConfigured()) await chooseBackupFolder();
          await nativeRestore(controller, secret());
          done("Wallet restored from folder");
        } catch (e) {
          fail(e);
        }
        return;
      }
      setMsg("restore-msg", "Fetching backup from Google Drive…");
      try {
        await driveRestore(controller, secret());
        done("Wallet restored from Drive");
      } catch (e) {
        fail(e);
      }
    })();
  });

  $("restore-file-btn").addEventListener("click", () => {
    void (async () => {
      const file = $<HTMLInputElement>("restore-file").files?.[0];
      if (!file) {
        setMsg("restore-msg", "Choose your backup .json file first.", "err");
        return;
      }
      if (!secret()) {
        setMsg("restore-msg", "Enter your recovery seed (it decrypts the backup).", "err");
        return;
      }
      setMsg("restore-msg", "Restoring…");
      try {
        const envelope = (await file.text()).trim();
        if (!envelope) {
          setMsg("restore-msg", "That file is empty.", "err");
          return;
        }
        await controller.restoreWallet(envelope, secret());
        done("Wallet restored");
      } catch (e) {
        fail(e);
      }
    })();
  });

  $("restore-confirm").addEventListener("click", () => {
    void (async () => {
      const envelope = $<HTMLTextAreaElement>("restore-env").value.trim();
      if (!envelope) {
        setMsg("restore-msg", "Paste your encrypted backup JSON — a seed alone can't restore channels.", "err");
        return;
      }
      if (!secret()) {
        setMsg("restore-msg", "Enter your recovery seed (it decrypts the backup).", "err");
        return;
      }
      setMsg("restore-msg", "Restoring…");
      try {
        await controller.restoreWallet(envelope, secret());
        done("Wallet restored");
      } catch (e) {
        fail(e);
      }
    })();
  });

  // Seed-only restore: brings back an EMPTY wallet (channels need a backup) — the same
  // fresh-node path as createWallet, so it carries the force-close guard.
  guardedClick($<HTMLButtonElement>("restore-seed-only"), async () => {
    const raw = secret();
    if (!raw) {
      setMsg("restore-msg", "Enter your recovery seed — a 24-word phrase or a 64-hex seed.", "err");
      return;
    }
    const seedHex = resolveSeedInput(raw);
    if (!seedHex) {
      setMsg("restore-msg", "That isn't a valid recovery seed (24 words or 64 hex).", "err");
      return;
    }
    const ok = await confirmModal({
      title: "Only for a seed with no channel",
      body:
        "Restoring with just a seed starts a brand-new, EMPTY wallet. If this seed already has a " +
        "channel, this will FORCE-CLOSE it once you connect. To bring back a funded wallet, cancel " +
        "and restore from your backup instead.",
      confirmLabel: "This seed has no channel — restore",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return;
    setMsg("restore-msg", "Restoring from seed…");
    try {
      await controller.createWallet({ seedHex });
      done("Wallet restored from seed");
    } catch (e) {
      fail(e);
    }
  });

  registerScreen("screen-restore", {
    onShow: () => {
      // In the native APK the Drive button restores from a SAF folder — relabel it so the copy matches.
      if (nativeBackupAvailable()) $("restore-drive").textContent = "Restore from folder";
    },
  });
  // The latch must survive refreshes: any state-changed while latched re-asserts this screen.
  onControllerEvent(() => {
    if (needsRestore && currentScreen() !== "screen-restore") {
      showScreen("screen-restore");
      setMsg("restore-msg", REGRESSION_MSG, "err");
    }
  });
}
