// Registers the service worker (offline shell + push wake) and wires the in-app Install button
// off the beforeinstallprompt event. Install is what makes iOS fire Web Push, so it matters beyond
// polish — see web-push.ts.

export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}service-worker.js`, { type: "module" })
      .catch((e) => console.warn("[SW] registration failed:", e?.message || e));
  });
}

export function wireInstallPrompt(): void {
  const btn = document.getElementById("install-btn") as HTMLButtonElement | null;
  if (!btn) return;
  let deferred: (Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }) | null = null;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // stop Chrome's mini-infobar; drive install from our button instead
    deferred = e as typeof deferred;
    btn.classList.remove("hidden");
  });

  btn.addEventListener("click", async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice.catch(() => {});
    deferred = null;
    btn.classList.add("hidden");
  });

  window.addEventListener("appinstalled", () => {
    deferred = null;
    btn.classList.add("hidden");
  });
}
