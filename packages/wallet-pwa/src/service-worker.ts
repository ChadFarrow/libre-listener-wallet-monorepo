import { LibreListenerWallet, IndexedDBStorageProvider } from "@libre/listener-wallet";
import { bridgeTargetUrl } from "@libre/shared";
import { dbNameForNetwork, META_DB_NAME, ACTIVE_NETWORK_KEY } from "./core/storage-namespace";
import { resolveSwConfig } from "./core/sw-config";

declare const self: any;

// ---- Installable-PWA offline app shell ----
// Bump this to invalidate the cached shell on release. The cache holds ONLY the static app shell;
// it must never cache or intercept wallet network traffic (esplora / bridge / Drive / nostr).
const SHELL_CACHE = "libre-shell-v1";
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

  // Same-origin navigations → serve the cached app shell so the PWA opens offline.
  if (req.mode === "navigate") {
    event.respondWith(
      caches.match("./index.html").then((cached: Response | undefined) => cached || fetch(req))
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
  // so we open the correct network-scoped DB (e.g. libre-wallet-mainnet) rather than
  // the legacy default (libre-wallet).
  const metaStore = new IndexedDBStorageProvider(META_DB_NAME);
  const activeNetwork = (await metaStore.getItem(ACTIVE_NETWORK_KEY)) || "regtest";
  const storage = new IndexedDBStorageProvider(dbNameForNetwork(activeNetwork));

  // Read config the main app persisted (the SW has no DOM). No localhost defaults —
  // a deployed SW must use the real remote esplora + bridge from config.
  const config = resolveSwConfig(await storage.getItem("ldk_config"));
  if (!config.esploraUrl) {
    console.error("[SW] No esploraUrl in ldk_config — cannot boot node on push; aborting.");
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
    }
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
    console.error("[SW] Error during offline payment processing:", err.message || err);
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
