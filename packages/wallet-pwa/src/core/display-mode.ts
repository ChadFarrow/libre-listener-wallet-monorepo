// Detect an installed (home-screen / standalone) PWA, where iOS Safari BLOCKS OAuth popups
// (`popup_failed_to_open`). The Drive connect flow uses this to switch to a full-page redirect
// instead of a popup on installed iOS (see core/drive-redirect.ts + drive-backup.ts).
//
// The pure predicate is separated from the DOM reads so it can be unit-tested without a browser.

// True when the page is running as an installed/standalone app. `standaloneMatch` is
// `matchMedia('(display-mode: standalone)').matches` (all installed PWAs); `navStandalone` is
// iOS Safari's legacy `navigator.standalone` (the reliable signal on older iOS home-screen apps).
export function isStandaloneDisplayFrom(input: { standaloneMatch: boolean; navStandalone?: boolean }): boolean {
  return input.standaloneMatch === true || input.navStandalone === true;
}

// DOM-backed convenience: reads matchMedia + navigator.standalone defensively (both absent in some
// engines / SSR). Never throws.
export function isStandaloneDisplay(): boolean {
  let standaloneMatch = false;
  try {
    standaloneMatch =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    /* matchMedia unavailable — fall back to navigator.standalone below */
  }
  const navStandalone =
    typeof navigator !== "undefined"
      ? (navigator as unknown as { standalone?: boolean }).standalone
      : undefined;
  return isStandaloneDisplayFrom({ standaloneMatch, navStandalone });
}
