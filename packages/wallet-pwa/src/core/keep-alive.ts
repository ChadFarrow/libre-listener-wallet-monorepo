// Background keep-alive policy + persisted toggle. The keep-alive plays a silent looping audio clip
// so iOS/Android treat the page as "playing media" and don't freeze it while backgrounded — which
// keeps the single foreground LDK node alive so NWC boosts settle in real time instead of only when
// the wallet is reopened. Opt-in (uses battery), default OFF. Pure decision here; the audio manager
// (core/keep-alive-audio.ts) applies it, and main.ts wires it to node run-state.

export const KEEP_ALIVE_KEY = "libre_keep_alive";

// Keep-alive should run only when the user enabled it, the node is actually running (nothing to keep
// alive otherwise), and we're not in demo (no real node).
export function shouldKeepAlive(opts: { enabled: boolean; running: boolean; demo: boolean }): boolean {
  return opts.enabled && opts.running && !opts.demo;
}

export function keepAliveEnabled(): boolean {
  try {
    return localStorage.getItem(KEEP_ALIVE_KEY) === "1";
  } catch {
    return false;
  }
}

// Whether to seed keep-alive ON by default on first run. Native (the Android APK) keeps the node
// alive via a foreground service, which is the whole reason the wrapper exists — so it should default
// ON there, but only when the user hasn't set the toggle yet (`stored === null`); an explicit "0"
// (user turned it off) is respected. The browser PWA/iOS default stays OFF (its audio keep-alive is
// opt-in — it can claim Now Playing / interrupt other audio). Pure so main.ts's boot seed is tested.
export function shouldSeedKeepAliveDefault(native: boolean, stored: string | null): boolean {
  return native && stored === null;
}

export function setKeepAliveEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEEP_ALIVE_KEY, on ? "1" : "0");
  } catch {
    /* private-mode / storage-disabled: the toggle just won't persist */
  }
}
