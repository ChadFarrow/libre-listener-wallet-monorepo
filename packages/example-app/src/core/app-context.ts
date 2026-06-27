import type { LibreListenerWallet } from "@libre/listener-wallet";

// Live accessors for the mutable app state owned by main.ts, handed to each
// feature module's init() so handlers always see the current wallet/run state
// without a global find/replace.
export interface AppContext {
  getWallet: () => LibreListenerWallet | null;
  isRunning: () => boolean;
}
