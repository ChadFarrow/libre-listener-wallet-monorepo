import { LibreListenerWallet, IndexedDBStorageProvider } from "@libre/listener-wallet";
import {
  bridgeTargetUrl,
  isChannelStateRegressionError,
  isNodeAlreadyRunningError,
  acquireWebNodeLock,
  nodeLockName,
} from "@libre/shared";
import { dbNameForNetwork, META_DB_NAME, ACTIVE_NETWORK_KEY } from "./core/storage-namespace";
import { resolveActiveNetwork, resolvePushConfig } from "./core/sw-config";
import { cleanRedirect } from "./core/sw-redirect";

declare const self: any;

// ---- Installable-PWA offline app shell ----
// Bump this to invalidate the cached shell on release. The cache holds ONLY the static app shell;
// it must never cache or intercept wallet network traffic (esplora / bridge / Drive / nostr).
// v2: drops any shell cached by the pre-cleanRedirect SW (a redirected index.html could have been
// stored, breaking iOS navigations — see core/sw-redirect.ts).
const SHELL_CACHE = "libre-shell-v2";
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
      fetch(req)
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

async function handlePushEvent(payload: { walletPubkey: string; relayUrl: string; eventId: string }) {
  // 1. Check if there are any active client windows open
  const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (clientsList.length > 0) {
    console.log("[SW] Active PWA window detected. Skipping offline background processing.");
    return;
  }

  console.log("[SW] Offline state. Booting LDK Node in background Service Worker...");

  // 2. Fetch configurations from storage — read the active network from the meta DB
  // so we open the correct network-scoped DB (e.g. libre-wallet-mainnet). Default to
  // mainnet (matching the controller) so a default-config install doesn't open the
  // wrong empty DB.
  const metaStore = new IndexedDBStorageProvider(META_DB_NAME);
  const activeNetwork = resolveActiveNetwork(await metaStore.getItem(ACTIVE_NETWORK_KEY));
  const storage = new IndexedDBStorageProvider(dbNameForNetwork(activeNetwork));

  // Read config the main app persisted (the SW has no DOM), layered over the network's
  // public defaults — so a wallet created on defaults (which only resolves esplora/bridge
  // in-memory) still boots here instead of silently aborting.
  const config = resolvePushConfig(await storage.getItem("ldk_config"), activeNetwork);
  if (!config.esploraUrl) {
    console.error("[SW] Cannot resolve an esplora endpoint for the offline node — showing a tap-to-open notification.");
    await self.registration.showNotification("Libre Listener Wallet", {
      body: "Pending offline NWC payment request. Tap to open and authorize.",
      tag: "nwc-payment-pending",
      data: { url: self.registration.scope },
    });
    return;
  }

  // Create a minimal WebSocket connection provider that uses browser WebSockets inside SW
  const socketProvider = {
    connect: async (host: string, port: number) => {
      const wsUrl = config.bridgeUrl;
      if (!wsUrl) {
        throw new Error("[SW] No bridgeUrl in ldk_config — cannot connect to peer on push.");
      }
      console.log(`[SW] SW Connecting WebSocket bridge to ${wsUrl}...`);
      const socket = new WebSocket(bridgeTargetUrl(wsUrl, host, port));
      socket.binaryType = "arraybuffer";

      const conn = {
        send: (data: Uint8Array) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(data);
          }
        },
        close: () => {
          socket.close();
        },
        onmessage: undefined as any,
        onerror: undefined as any,
        onclose: undefined as any,
      };

      socket.onmessage = (event) => {
        conn.onmessage?.(new Uint8Array(event.data));
      };

      socket.onerror = (err) => {
        conn.onerror?.(new Error("WebSocket error"));
      };

      socket.onclose = () => {
        conn.onclose?.();
      };

      return new Promise<any>((resolve, reject) => {
        socket.onopen = () => {
          console.log("[SW] SW WebSocket bridge connected!");
          resolve(conn);
        };
        socket.onerror = () => {
          reject(new Error("SW WebSocket failed"));
        };
      });
    }
  };

  const wallet = new LibreListenerWallet({
    config: {
      network: config.network as "mainnet" | "testnet" | "regtest" | "signet",
      esploraUrl: config.esploraUrl,
    },
    storage,
    socketProvider,
    wasmUrl: "./liblightningjs.wasm",
    logger: {
      info: (msg, ...args) => console.log("[SW LDK INFO]", msg, ...args),
      warn: (msg, ...args) => console.warn("[SW LDK WARN]", msg, ...args),
      error: (msg, ...args) => console.error("[SW LDK ERROR]", msg, ...args),
    },
    // Per-origin single-node lock: if the page's tab holds the node, the SW must not build a second
    // node over the same storage — it should quietly skip offline processing instead.
    acquireRunLock: () => acquireWebNodeLock(nodeLockName(dbNameForNetwork(activeNetwork))),
  });

  let processed = false;

  const processPromise = new Promise<void>((resolve) => {
    wallet.nwc.onRequestProcessed((res) => {
      console.log("[SW] NWC Request processed event:", res);
      if (res.eventId === payload.eventId) {
        processed = true;
        resolve();
      }
    });
  });

  try {
    await wallet.start();
    console.log("[SW] Wallet started in background. Waiting for NWC payment to resolve...");

    // Wait for resolution or timeout (10 seconds)
    await Promise.race([
      processPromise,
      new Promise((resolve) => setTimeout(resolve, 10000))
    ]);

  } catch (err: any) {
    if (isNodeAlreadyRunningError(err)) {
      console.log("[SW] App is open (holds the node lock) — skipping offline processing.");
      return; // page owns the node; do NOT show a fallback notification
    }
    console.error("[SW] Error during offline payment processing:", err.message || err);
    if (isChannelStateRegressionError(err)) {
      await self.registration.showNotification("Libre Listener Wallet", {
        body: "This wallet's channel state is behind what it durably reached — open the app and restore from backup before starting the node.",
        tag: "nwc-restore-needed",
        data: {
          url: self.registration.scope
        }
      });
      return;
    }
  } finally {
    console.log("[SW] Stopping background wallet node...");
    try {
      await wallet.stop();
    } catch (e) {}
  }

  // 3. Fallback notification
  if (!processed) {
    console.log("[SW] Background payment execution timed out or failed. Displaying fallback push notification.");

    await self.registration.showNotification("Libre Listener Wallet", {
      body: "Pending offline NWC payment request. Tap to open and authorize.",
      tag: "nwc-payment-pending",
      data: {
        url: self.registration.scope
      }
    });
  } else {
    console.log("[SW] Offline background payment successfully processed & settled!");
  }
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
