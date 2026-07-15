import type { WalletControllerApi } from "@libre/wallet-core";
import type { KeepAlive } from "./keep-alive-audio";

// Live accessors handed to each feature module's init() so handlers always see the
// current controller / run state without a global reference. In the PWA the single
// WalletController owns the one LDK node directly (no offscreen/RPC hop), so views
// call it as plain method calls.
export interface AppContext {
  // The controller's public surface (WalletControllerApi), not the class: the class has private
  // fields (nominal), so the DemoController / test stubs could never satisfy it structurally.
  controller: WalletControllerApi;
  isRunning: () => boolean;
  // Background keep-alive (silent audio) so the developer toggle can start it within a user gesture.
  keepAlive: KeepAlive;
}
