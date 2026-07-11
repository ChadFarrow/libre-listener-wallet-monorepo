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

// In-memory stand-ins for the app-layer markers the onboarding gate + status pill read from
// localStorage in the real app (getSeedBackedUp / driveConfigured).
export const demoState = {
  seedBackedUp: false,
  driveConfigured: false,
};
