// NOTE: the service worker no longer bundles the Lightning SDK. Offline wake is notification-only
// (see handlePushEvent) — it never boots a node — so the whole LDK/config/lock surface is gone from
// this bundle, which also removes the "SW must bundle every dependency" hazard and shrinks it.
import { cleanRedirect } from "./core/sw-redirect";

declare const self: any;

// ---- Installable-PWA offline app shell ----
// Bump this to invalidate the cached shell on release. The cache holds ONLY the static app shell;
// it must never cache or intercept wallet network traffic (esplora / bridge / Drive / nostr).
// v2: drops any shell cached by the pre-cleanRedirect SW (a redirected index.html could have been
// stored, breaking iOS navigations — see core/sw-redirect.ts).
// v3: iOS stale-cache eviction. The demo-mode Drive-signin fixes only touched app JS, not this SW,
// so its bytes never changed — iOS therefore never installed a new SW and kept serving the old
// hashed bundle (cache-first) behind a stale index.html, so ?demo kept firing a real Google
// sign-in on iOS. Bumping this constant changes the SW bytes, which forces iOS to install + activate
// the new worker (purging every old cache below) and, together with the no-store navigation fetch,
// breaks the loop so stuck clients pull the fixed bundle.
const SHELL_CACHE = "libre-shell-v3";
// Stable-named shell entries (relative to the SW scope, matching Vite's base:"./"). Hashed
// main.js/style.css and the large WASM are cached lazily on first fetch instead of precached.
const SHELL_PRECACHE = ["./", "./index.html", "./manifest.webmanifest"];

self.addEventListener("install", (event: any) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache: Cache) => cache.addAll(SHELL_PRECACHE))
      .catch((e: any) => console.warn("[SW] shell precache failed:", e?.message || e))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event: any) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys: string[]) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event: any) => {
  const req: Request = event.request;
  if (req.method !== "GET") return; // never touch POST/PUT (Drive uploads, gateway register)
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin (esplora/bridge/Drive/nostr) → network as normal

  // Same-origin navigations → NETWORK-FIRST, cache fallback. A wallet must never be pinned on a
  // stale shell: online we always fetch (and refresh) the current index.html; offline we fall back
  // to the cached shell so the PWA still opens.
  if (req.mode === "navigate") {
    event.respondWith(
      // no-store: bypass Safari's HTTP disk cache so we can't be handed a stale index.html that
      // points back at an already-cached old bundle (the iOS ?demo-signin stale-loop). Offline this
      // rejects and we fall back to the cached shell below.
      fetch(req, { cache: "no-store" })
        .then(async (res: Response) => {
          // iOS Safari rejects a navigation served with a redirected response
          // ("Response served by service worker has redirections") — Cloudflare Pages
          // sometimes 3xx-redirects the launch URL. Strip the flag before returning/caching.
          const clean = await cleanRedirect(res);
          if (clean.ok) {
            const copy = clean.clone();
            void caches.open(SHELL_CACHE).then((cache: Cache) => cache.put("./index.html", copy));
          }
          return clean;
        })
        .catch(async () => (await caches.match("./index.html")) || (await caches.match("./")) || Response.error())
    );
    return;
  }

  // Same-origin static assets (hashed js/css, icons, wasm) → cache-first, populate on first fetch.
  event.respondWith(
    caches.match(req).then((cached: Response | undefined) => {
      if (cached) return cached;
      return fetch(req).then((res: Response) => {
        if (res.ok) {
          const copy = res.clone();
          void caches.open(SHELL_CACHE).then((cache: Cache) => cache.put(req, copy));
        }
        return res;
      });
    })
  );
});

self.addEventListener("push", (event: any) => {
  if (!event.data) return;

  let payload: any;
  try {
    payload = event.data.json();
  } catch (e: any) {
    console.error("[SW] Failed to parse push notification payload:", e.message || e);
    return;
  }

  console.log("[SW] Push received:", payload);

  event.waitUntil(
    handlePushEvent(payload)
  );
});

async function handlePushEvent(_payload: { walletPubkey: string; relayUrl: string; eventId: string }) {
  // NOTIFICATION-ONLY WAKE. We deliberately DO NOT boot a Lightning node in the service worker.
  //
  // The old path booted a second LDK node here to pay silently in the background. On iOS the SW
  // gets only a few seconds and is killed mid-operation — which could leave channel state behind
  // what the peer saw, and on the next reconnect the peer force-closes the channel (this cost a
  // real channel on mainnet). The "reliability" it bought was marginal anyway: iOS rarely gives a
  // background node enough time to route + settle a payment.
  //
  // Instead we just nudge the user to OPEN the app, where the stable foreground node connects to
  // the relay and completes the still-pending request (NWC requests are valid for 300s). Opening
  // the app is the safe, node-in-foreground path the user already relies on. iOS also REQUIRES a
  // visible notification for every push, so a single notification here also keeps the subscription
  // alive. If a window is already open, the foreground node is handling it live — say nothing.
  const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (clientsList.length > 0) {
    console.log("[SW] Active PWA window — the foreground node handles the request. No notification.");
    return;
  }

  console.log("[SW] Offline push — showing tap-to-open notification (no background node).");
  await self.registration.showNotification("Payment request", {
    body: "A Lightning payment is waiting. Tap to open your wallet and complete it.",
    tag: "nwc-payment-pending",
    data: { url: self.registration.scope },
  });
}

self.addEventListener("notificationclick", (event: any) => {
  event.notification.close();
  const urlToOpen = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients: any[]) => {
      for (const client of windowClients) {
        if (client.url === urlToOpen && "focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(urlToOpen);
      }
    })
  );
});
