// Boundary-stable discriminator for the SDK's ChannelStateRegressionError (thrown by
// LibreListenerWallet.start() when loaded channel state has regressed below a durably-reached
// high-water — halting instead of reconnecting stale state and being force-closed).
//
// Lives in @libre/shared (LDK-free) so the browser-extension popup can detect it WITHOUT importing
// the SDK/WASM. Matching semantics (code field OR flattened-message token) live in error-code.ts.
import { errorMatchesCode } from "./error-code";

export const CHANNEL_STATE_REGRESSION_CODE = "CHANNEL_STATE_REGRESSION";

export function isChannelStateRegressionError(e: unknown): boolean {
  return errorMatchesCode(e, CHANNEL_STATE_REGRESSION_CODE);
}
