import type { AppContext } from "../core/app-context";
import { onControllerEvent, emitControllerEvent } from "../core/events";
import { statusPill, type StatusPillTarget } from "../core/status-pill";
import { bootLoadingVisible } from "../core/boot-loading";
import { AUTO_START_KEY, isAutoStartEnabled } from "@libre/shared";
import { channelLifecycle } from "../core/channel-lifecycle";
import { balanceDisplay } from "../core/balance-display";
import { loadLastBalanceSats, saveLastBalanceSats } from "../core/balance-cache";
import { getSeedBackedUp } from "../core/onboarding";
import { driveConfigured, driveConnected, ensureDriveConnected } from "../drive-integration";
import { isDemoMode, demoState } from "../core/demo-mode";
import { getUsdRate, satsToUsd } from "../core/fiat-rate";
import { keepAliveEnabled, setKeepAliveEnabled } from "../core/keep-alive";
import { bgChipView } from "../core/bg-mode";
import { ensureOverlayPermission, isNativeApp } from "../core/native-bridge";
import { nativeBackupAvailable, backupFolderConfigured } from "../core/native-backup";
import { registerScreen, showScreen, currentScreen, openDrawer } from "../ui/nav";
import { startNodeWithGuards } from "./start-node";
import { $, show, fmtSats } from "./util";

// Where each pill target lives — tapping the pill deep-links to the fixing screen.
const PILL_SCREEN: Record<StatusPillTarget, string | "drawer"> = {
  node: "screen-node",
  "get-channel": "screen-get-channel",
  channels: "screen-channels",
  "cloud-backup": "screen-backup",
  // reconnect-drive is handled as an inline action (one-tap reconnect); the backup screen is the
  // fallback destination if that reconnect can't complete.
  "reconnect-drive": "screen-backup",
  recovery: "screen-recovery",
  sweep: "screen-sweep",
};

// How long after launch to treat the status pill as "settling": long enough to cover the node coming
// up AND the Drive token silently reconnecting, so the pill doesn't flicker stopped → running →
// cloud-backup-disconnected during boot. After this, whatever's still wrong shows (calmly, once).
export const PILL_SETTLE_MS = 12_000;

export function initHomeScreen(ctx: AppContext): void {
  const controller = ctx.controller;
  let pillTarget: StatusPillTarget | null = null;
  // App-launch timestamp for the pill settle window (see PILL_SETTLE_MS). Captured once at init so it
  // tracks the page load; an OAuth-redirect reload restarts the app and re-arms the grace naturally.
  const bootAt = Date.now();
  // Last confirmed spendable, held across a background→resume so the balance doesn't flash 0 while
  // the peer reconnects (see core/balance-display.ts). Seeded from the persisted cache so even a cold
  // boot shows the real balance during the peer-connect window instead of the 0-flash.
  let lastShownSats: number | null = loadLastBalanceSats();

  async function refresh(): Promise<void> {
    try {
      const s = await controller.getState();
      const bal = balanceDisplay({
        balance: s.balance,
        hasChannelState: s.hasChannelState,
        lastShownSats,
      });
      if (bal.sats != null && !bal.stale) {
        lastShownSats = bal.sats; // remember only fresh readings
        saveLastBalanceSats(bal.sats); // persist so a cold boot can seed from it (no 0-flash)
      }
      $("balance-sats").textContent = bal.sats != null ? fmtSats(bal.sats) : "—";
      // Fiat line: best-effort, hidden whenever no rate is available (offline, API down).
      const fiatEl = $("balance-fiat");
      if (bal.sats != null) {
        const rate = await getUsdRate();
        show(fiatEl, rate != null);
        if (rate != null) fiatEl.textContent = `$${satsToUsd(bal.sats, rate).toFixed(2)}`;
      } else {
        show(fiatEl, false);
      }

      const lifecycle = channelLifecycle({
        channels: s.channels ?? 0,
        usableChannels: s.usableChannels ?? 0,
        closeCount: s.closes?.count ?? 0,
        sweepNeedsAddress: s.sweep?.needsAddress ?? false,
        sweepPendingCount: s.sweep?.pendingCount ?? 0,
      });

      // Post-close context: balance 0 is not "empty wallet" while funds are coming back on-chain.
      const recEl = $("balance-recovering");
      if (lifecycle === "closed-recovering" || lifecycle === "closed-needs-address") {
        const sat = s.sweep?.pendingSat ?? 0;
        recEl.textContent =
          lifecycle === "closed-needs-address"
            ? "Channel closed — funds waiting for a recovery address"
            : sat > 0
              ? `Recovering ${fmtSats(sat)} sats to your on-chain address`
              : "Recovering your funds on-chain";
        show(recEl, true);
      } else {
        show(recEl, false);
      }

      // Within the post-launch settle window? Used both to suppress the transient boot pills and to
      // show the "Starting your node…" loader in their place (see PILL_SETTLE_MS / boot-loading).
      const settling = Date.now() - bootAt < PILL_SETTLE_MS;

      // Boot loader: a clear "starting" state instead of a bare "— sats" placeholder while the node
      // comes up on launch. Mutually exclusive with the pill (both are suppressed while booting).
      show(
        $("boot-loading"),
        bootLoadingVisible({
          running: s.running,
          starting: s.starting ?? false,
          settling,
          autoStartOn: isAutoStartEnabled(localStorage.getItem(AUTO_START_KEY)),
        }),
      );

      const pill = statusPill({
        hasWallet: s.hasSeed || s.createdNew || s.hasChannelState,
        running: s.running,
        starting: s.starting ?? false,
        // Suppress the transient boot pills for the first few seconds after launch (see PILL_SETTLE_MS)
        // so the pill doesn't flash stopped → running → cloud-backup while the node + Drive settle.
        settling,
        startError: s.startError,
        lifecycle,
        // In the native APK, "cloud backup" is a chosen SAF folder (core/native-backup), not a Drive
        // account — and SAF has no live-token/reconnect concept, so a chosen folder is both
        // "configured" AND "connected" (no false "disconnected — reconnect" nag).
        driveConfigured: isDemoMode()
          ? demoState.driveConfigured
          : nativeBackupAvailable()
            ? backupFolderConfigured()
            : driveConfigured(),
        // Demo has no real token; treat a configured demo wallet as connected so the nag never shows.
        driveConnected: isDemoMode()
          ? demoState.driveConfigured
          : nativeBackupAvailable()
            ? backupFolderConfigured()
            : driveConnected(),
        backedUp: isDemoMode() ? demoState.seedBackedUp : getSeedBackedUp(s.network),
      });
      const pillEl = $("status-pill");
      show(pillEl, !!pill);
      if (pill) {
        pillEl.className = `status-pill ${pill.level}`;
        $("status-pill-text").textContent = pill.text;
        pillTarget = pill.target;
      } else {
        pillTarget = null;
      }
      refreshBgChip();
    } catch (e) {
      console.warn("[Home] refresh failed:", (e as Error)?.message || e);
    }
  }

  $("status-pill").addEventListener("click", () => {
    if (!pillTarget) return;
    // One-tap Drive reconnect: THIS click is a trusted user gesture, which is exactly what the
    // interactive OAuth popup needs to open on an installed iOS PWA (the silent, gesture-less
    // reconnect can't). On success the auto-sync resumes; on failure fall back to the backup screen.
    if (pillTarget === "reconnect-drive") {
      void reconnectDrive();
      return;
    }
    // "Node stopped — tap to start": start the node right here instead of sending the user to the
    // Node screen to press Start there. Target "node" only appears when the node is stopped, so this
    // is always a start. Shares the Node screen's fund-safety guards (a channel-state regression /
    // backup-ahead start still routes to the forced-restore screen, never a raw start on stale state).
    if (pillTarget === "node") {
      void startFromPill();
      return;
    }
    const dest = PILL_SCREEN[pillTarget];
    if (dest === "drawer") openDrawer();
    else showScreen(dest);
  });

  async function startFromPill(): Promise<void> {
    await startNodeWithGuards(controller, (msg) => {
      $("status-pill-text").textContent = msg;
    });
    // refresh() reconciles the pill with real state (hides it once running, or reverts to the
    // stopped pill — showing getState().startError — if the start failed for a non-routed reason).
    void refresh();
  }

  async function reconnectDrive(): Promise<void> {
    const text = $("status-pill-text");
    const prev = text.textContent;
    text.textContent = "Reconnecting Google Drive…";
    try {
      await ensureDriveConnected();
      // Connected — arm the auto-sync (main.ts's shouldDriveAutoSync fires on state-changed once a
      // live token exists) and refresh so the nag clears.
      emitControllerEvent("state-changed");
      void refresh();
    } catch (e) {
      console.warn("[Home] Drive reconnect failed:", (e as Error)?.message || e);
      text.textContent = prev;
      // Couldn't complete inline (popup blocked/cancelled) — send them to the full backup screen.
      showScreen("screen-backup");
    }
  }

  // ---- Background-mode chip (keep-alive audio) ----
  // The ONE place a user can reliably start keep-alive: this click is a trusted gesture, which is
  // exactly what iOS requires to begin audio playback. Once playing, the node stays alive while the
  // app is backgrounded, so boosts sent from another app settle without switching back here. Best-
  // effort — iOS can still suspend under memory pressure — but it's the only path to hands-off boosts.
  const bgChip = $("bg-mode-chip");
  function refreshBgChip(): void {
    const v = bgChipView({
      demo: isDemoMode(),
      nodeRunning: controller.isRunning(),
      active: ctx.keepAlive.isActive(),
      enabled: keepAliveEnabled(),
      native: isNativeApp(),
    });
    show(bgChip, v.visible);
    bgChip.classList.toggle("on", v.on);
    if (v.visible) $("bg-mode-text").textContent = v.text;
  }
  bgChip.addEventListener("click", () => {
    if (ctx.keepAlive.isActive()) {
      setKeepAliveEnabled(false);
      ctx.keepAlive.stop();
    } else {
      setKeepAliveEnabled(true);
      if (controller.isRunning()) ctx.keepAlive.start(); // mark wanted (play may be gesture-gated)
      ctx.keepAlive.unlock(); // within THIS click → satisfies the iOS autoplay gate, starts audio
      // Native wrapper: the overlay ("draw over other apps") permission is what keeps the node alive
      // while occluded — prompt for it once, here, on the explicit enable gesture. No-op in a PWA.
      void ensureOverlayPermission();
    }
    refreshBgChip();
    // play() resolves a tick later; re-read once it has so the chip reflects the real state.
    setTimeout(refreshBgChip, 400);
  });

  $("btn-receive").addEventListener("click", () => showScreen("screen-receive"));
  $("btn-send").addEventListener("click", () => showScreen("screen-send"));

  registerScreen("screen-home", { onShow: () => void refresh() });
  onControllerEvent(() => {
    if (currentScreen() === "screen-home") void refresh();
  });
  // Peer connects/drops emit no wallet events (only channel-state persists do) — poll while
  // home is the visible screen.
  setInterval(() => {
    if (currentScreen() === "screen-home" && !document.hidden) void refresh();
  }, 5000);
  // When the settle window ends, refresh once so any still-unresolved state (genuinely stopped, Drive
  // truly disconnected) surfaces promptly instead of waiting up to 5s for the next poll.
  setTimeout(() => {
    if (currentScreen() === "screen-home") void refresh();
  }, PILL_SETTLE_MS + 100);
  void refresh();
}
