import type { AppContext } from "../core/app-context";
import { onControllerEvent } from "../core/events";
import { statusPill, type StatusPillTarget } from "../core/status-pill";
import { channelLifecycle } from "../core/channel-lifecycle";
import { balanceDisplay } from "../core/balance-display";
import { getSeedBackedUp } from "../core/onboarding";
import { driveConfigured } from "../drive-integration";
import { isDemoMode, demoState } from "../core/demo-mode";
import { getUsdRate, satsToUsd } from "../core/fiat-rate";
import { registerScreen, showScreen, currentScreen, openDrawer } from "../ui/nav";
import { $, show, fmtSats } from "./util";

// Where each pill target lives — tapping the pill deep-links to the fixing screen.
const PILL_SCREEN: Record<StatusPillTarget, string | "drawer"> = {
  node: "screen-node",
  "get-channel": "screen-get-channel",
  channels: "screen-channels",
  "cloud-backup": "screen-backup",
  recovery: "screen-recovery",
  sweep: "screen-sweep",
};

export function initHomeScreen(ctx: AppContext): void {
  const controller = ctx.controller;
  let pillTarget: StatusPillTarget | null = null;
  // Last confirmed spendable, held across a background→resume so the balance doesn't flash 0 while
  // the peer reconnects (see core/balance-display.ts). Survives backgrounding as a closure var.
  let lastShownSats: number | null = null;

  async function refresh(): Promise<void> {
    try {
      const s = await controller.getState();
      const bal = balanceDisplay({
        balance: s.balance,
        channels: s.channels ?? 0,
        usableChannels: s.usableChannels ?? 0,
        lastShownSats,
      });
      if (bal.sats != null && !bal.stale) lastShownSats = bal.sats; // remember only fresh readings
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

      const pill = statusPill({
        hasWallet: s.hasSeed || s.createdNew || s.hasChannelState,
        running: s.running,
        startError: s.startError,
        lifecycle,
        driveConfigured: isDemoMode() ? demoState.driveConfigured : driveConfigured(),
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
    } catch (e) {
      console.warn("[Home] refresh failed:", (e as Error)?.message || e);
    }
  }

  $("status-pill").addEventListener("click", () => {
    if (!pillTarget) return;
    const dest = PILL_SCREEN[pillTarget];
    if (dest === "drawer") openDrawer();
    else showScreen(dest);
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
  void refresh();
}
