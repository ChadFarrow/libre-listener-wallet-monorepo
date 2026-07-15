// Smooths transient is_usable dips out of the usable-channel count shown in the UI.
//
// LDK marks a channel not-usable while a monitor update is in flight (the durable-persist
// window) and while a socket blips — and the UI refreshes on state-changed, which fires at
// exactly those moments. A perfectly healthy wallet therefore flashed "0/1" in the drawer
// (and flipped the home pill to "channel opening") during e.g. a Drive auto-sync. Hold the
// last-good count for a short grace window instead; a REAL outage (peer offline, channel
// closed) outlives the window and then shows truthfully. Same transient class — and same
// trade-off — as core/balance-display.ts.

export interface UsableSmootherState {
  lastGood: number;
  channels: number;
  dipSinceMs?: number;
}

const GRACE_MS = 10_000;

export function smoothUsable(
  state: UsableSmootherState | undefined,
  usable: number,
  channels: number,
  nowMs: number,
  graceMs = GRACE_MS
): { shown: number; state: UsableSmootherState } {
  // First reading, no channels, or the channel count itself changed (a real open/close):
  // show the truth and restart smoothing from it.
  if (!state || channels === 0 || channels !== state.channels) {
    return { shown: usable, state: { lastGood: usable, channels } };
  }
  if (usable >= state.lastGood) {
    return { shown: usable, state: { lastGood: usable, channels } };
  }
  // Dip below the last-good count: hold the old value through the grace window.
  const dipSinceMs = state.dipSinceMs ?? nowMs;
  if (nowMs - dipSinceMs < graceMs) {
    return { shown: state.lastGood, state: { ...state, dipSinceMs } };
  }
  // Outlived the grace window — it's a genuine outage; accept the lower count.
  return { shown: usable, state: { lastGood: usable, channels } };
}
