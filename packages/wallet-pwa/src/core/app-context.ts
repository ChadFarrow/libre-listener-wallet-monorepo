import type { WalletController } from "../wallet-controller";

// Live accessors handed to each feature module's init() so handlers always see the
// current controller / run state without a global reference. In the PWA the single
// WalletController owns the one LDK node directly (no offscreen/RPC hop), so views
// call it as plain method calls.
export interface AppContext {
  controller: WalletController;
  isRunning: () => boolean;
}
