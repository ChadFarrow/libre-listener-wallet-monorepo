import { LibreListenerWallet, IndexedDBStorageProvider } from "@libre/listener-wallet";
import { dbNameForNetwork, META_DB_NAME, ACTIVE_NETWORK_KEY } from "./core/storage-namespace";

declare const self: any;

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

  // Read config from IndexedDB if saved
  let configJson = await storage.getItem("ldk_config");
  let config = {
    network: "regtest" as const,
    esploraUrl: "http://127.0.0.1:3002",
  };
  if (configJson) {
    try {
      config = JSON.parse(configJson);
    } catch (e) {}
  }

  // Create a minimal WebSocket connection provider that uses browser WebSockets inside SW
  const socketProvider = {
    connect: async (host: string, port: number) => {
      const wsUrl = "ws://127.0.0.1:8081";
      console.log(`[SW] SW Connecting WebSocket bridge to ${wsUrl}...`);
      const socket = new WebSocket(wsUrl);
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
    config,
    storage,
    socketProvider,
    wasmUrl: "/liblightningjs.wasm",
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
