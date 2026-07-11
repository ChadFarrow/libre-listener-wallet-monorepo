// Demo mode: a UI playground with NO real wallet, node, or storage. Entered with ?demo in the
// URL (persisted per-tab in sessionStorage so reloads stay in demo); exited from the drawer.
// Everything demo lives in memory / sessionStorage — it must never touch the real wallet's
// IndexedDB or the app's localStorage markers (seed-backed-up, drive hint), so a demo session
// on a funded install can't pollute real state.

const DEMO_KEY = "libre_demo";

// Demo can be requested via the ?demo query OR a #demo hash fragment. The hash matters on iOS:
// a home-screen PWA relaunches at the manifest start_url, and iOS STRIPS the query string from it
// (so "./?demo" → "./" and the real app boots), but it preserves the fragment (client-side, never
// sent to the server). So the demo manifest's start_url carries "#demo" and we honor it here.
export function urlHasDemo(search: string, hash = ""): boolean {
  try {
    if (new URLSearchParams(search).has("demo")) return true;
  } catch {
    /* malformed search — fall through to the hash check */
  }
  return hash.replace(/^#/, "").split(/[&/]/).includes("demo");
}

// The URL is authoritative on every boot: a demo marker enters demo, and its absence CLEARS the
// per-tab latch. Without the clear, a tab that ever visited ?demo stayed demo forever — the plain
// URL kept booting demo (and blocking Drive) after a same-tab navigation, a session-restored tab,
// or a duplicated tab, all of which carry sessionStorage. Reloads keep ?demo in the URL (in-app
// navigation pushState never rewrites it), so legit demo sessions still survive reload.
export function enterDemoFromUrl(search: string, hash = ""): void {
  try {
    if (urlHasDemo(search, hash)) sessionStorage.setItem(DEMO_KEY, "1");
    else sessionStorage.removeItem(DEMO_KEY);
  } catch {
    /* sessionStorage unavailable — demo simply won't engage */
  }
}

export function isDemoMode(): boolean {
  try {
    return sessionStorage.getItem(DEMO_KEY) === "1";
  } catch {
    return false;
  }
}

export function exitDemo(): void {
  try {
    sessionStorage.removeItem(DEMO_KEY);
  } catch {
    /* ignore */
  }
  location.href = location.pathname; // strip ?demo/#demo and reboot into the real app
}

// Point the live manifest <link> at the demo manifest so an "Add to Home Screen" from the demo
// captures its start_url (which carries #demo). iOS launches an installed PWA at the manifest's
// start_url, and the real manifest's "." — plus iOS stripping any query — means a home-screen
// install otherwise boots as the REAL app (real Google sign-in in onboarding). The demo manifest's
// start_url uses a #demo fragment, which iOS preserves. The real app never runs this, so its
// manifest is untouched. Pure resolver split out for tests.
const DEMO_MANIFEST = "manifest-demo.webmanifest";

export function resolveManifestHref(currentHref: string | null | undefined, demoManifest = DEMO_MANIFEST): string {
  // Preserve the existing href's directory (Vite base) and swap only the filename.
  const base = (currentHref || "manifest.webmanifest").replace(/[^/]*$/, "");
  return `${base}${demoManifest}`;
}

export function applyDemoManifest(): void {
  try {
    const link = document.querySelector('link[rel="manifest"]') as HTMLLinkElement | null;
    if (!link) return;
    link.href = resolveManifestHref(link.getAttribute("href"));
  } catch {
    /* no DOM / no manifest link — demo still works, just can't fix the install launch URL */
  }
}

// In-memory stand-ins for the app-layer markers the onboarding gate + status pill read from
// localStorage in the real app (getSeedBackedUp / driveConfigured).
export const demoState = {
  seedBackedUp: false,
  driveConfigured: false,
};
