import type { AppContext } from "../core/app-context";
import { initNav } from "../ui/nav";
import { initDrawer } from "./drawer";
import { initHomeScreen } from "./home";
import { initNodeScreen } from "./node";
import { initRestoreScreen } from "./restore";
import { initReceiveScreen } from "./receive";
import { initGetChannelScreen } from "./get-channel";
import { initChanSuccessScreen } from "./chan-success";
import { initChannelsScreen } from "./channels";
import { initPeersScreen } from "./peers";
import { initAppConnectionsScreen } from "./app-connections";
import { initCloudBackupScreen } from "./cloud-backup";
import { initRecoveryScreen } from "./recovery";
import { initRecoveryAddressScreen } from "./recovery-address";
import { initDeveloperScreen } from "./developer";
import { initOnboarding } from "./onboarding";

// Wire the whole screen system against the static index.html shell. Order matters only in
// that initNav() must run first (it owns the stack + gesture/history wiring).
export function initScreens(ctx: AppContext): void {
  initNav();
  initDrawer(ctx);
  initHomeScreen(ctx);
  initNodeScreen(ctx);
  initRestoreScreen(ctx);
  initReceiveScreen(ctx);
  initGetChannelScreen(ctx);
  initChanSuccessScreen();
  initChannelsScreen(ctx);
  initPeersScreen(ctx);
  initAppConnectionsScreen(ctx);
  initCloudBackupScreen(ctx);
  initRecoveryScreen(ctx);
  initRecoveryAddressScreen(ctx);
  initDeveloperScreen(ctx);
  initOnboarding(ctx);
}
