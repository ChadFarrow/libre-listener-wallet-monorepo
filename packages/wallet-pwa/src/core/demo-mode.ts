// Demo mode: a UI playground with NO real wallet, node, or storage. Entered with ?demo in the
// URL (persisted per-tab in sessionStorage so reloads stay in demo); exited from the drawer.
// Everything demo lives in memory / sessionStorage — it must never touch the real wallet's
// IndexedDB or the app's localStorage markers (seed-backed-up, drive hint), so a demo session
// on a funded install can't pollute real state.

const DEMO_KEY = "libre_demo";

export function enterDemoFromUrl(search: string): void {
  try {
    if (new URLSearchParams(search).has("demo")) sessionStorage.setItem(DEMO_KEY, "1");
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
  location.href = location.pathname; // strip ?demo and reboot into the real app
}

// Point the live manifest <link> at the demo manifest so an "Add to Home Screen" from the demo
// captures its start_url (./?demo). iOS launches an installed PWA at the manifest's start_url, and
// the real manifest's "." strips the ?demo query — so without this a home-screen install boots as
// the REAL app (real Google sign-in in onboarding). The real app never runs this, so its manifest
// is untouched. Pure resolver split out for tests.
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
