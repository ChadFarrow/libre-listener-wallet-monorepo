import type { AppContext } from "../core/app-context";
import { onControllerEvent } from "../core/events";
import { statusPill, type StatusPillTarget } from "../core/status-pill";
import { getSeedBackedUp } from "../core/onboarding";
import { driveConfigured } from "../drive-integration";
import { registerScreen, showScreen, currentScreen, openDrawer } from "../ui/nav";
import { $, show, fmtSats } from "./util";

// Where each pill target lives. channels/cloud-backup/recovery get real screens in a later
// step — until then they land on the closest useful surface.
const PILL_SCREEN: Record<StatusPillTarget, string | "drawer"> = {
  node: "screen-node",
  "get-channel": "screen-get-channel",
  channels: "screen-node",
  "cloud-backup": "drawer",
  recovery: "drawer",
};

export function initHomeScreen(ctx: AppContext): void {
  const controller = ctx.controller;
  let pillTarget: StatusPillTarget | null = null;

  async function refresh(): Promise<void> {
    try {
      const s = await controller.getState();
      $("balance-sats").textContent = s.balance ? fmtSats(s.balance.spendableSat) : "—";

      const pill = statusPill({
        hasWallet: s.hasSeed || s.createdNew || s.hasChannelState,
        running: s.running,
        startError: s.startError,
        channels: s.channels ?? 0,
        usableChannels: s.usableChannels ?? 0,
        driveConfigured: driveConfigured(),
        backedUp: getSeedBackedUp(s.network),
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
