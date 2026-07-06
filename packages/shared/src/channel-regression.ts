// Boundary-stable discriminator for the SDK's ChannelStateRegressionError (thrown by
// LibreListenerWallet.start() when loaded channel state has regressed below a durably-reached
// high-water — halting instead of reconnecting stale state and being force-closed).
//
// Lives in @libre/shared (LDK-free) so the browser-extension popup can detect it WITHOUT importing
// the SDK/WASM. The error crosses chrome.runtime.sendMessage (offscreen→background→popup), which
// destroys the Error class — only `.message` survives. So the code is matched BOTH as an object
// `.code` (in-process frontends) AND as a substring of a flattened message/string (the extension).

export const CHANNEL_STATE_REGRESSION_CODE = "CHANNEL_STATE_REGRESSION";

export function isChannelStateRegressionError(e: unknown): boolean {
  if (e == null) return false;
  if (typeof e === "string") return e.includes(CHANNEL_STATE_REGRESSION_CODE);
  if (typeof e === "object") {
    if ((e as { code?: unknown }).code === CHANNEL_STATE_REGRESSION_CODE) return true;
    const msg = (e as { message?: unknown }).message;
    return typeof msg === "string" && msg.includes(CHANNEL_STATE_REGRESSION_CODE);
  }
  return false;
}
