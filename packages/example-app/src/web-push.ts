// Service Worker registration + Web Push (offline NWC wake-ups via the gateway),
// plus the "simulate offline request" helper.
import { appendLog } from "./core/logger";
import { IndexedDBStorageProvider } from "@libre/listener-wallet";
import { dbNameForNetwork, META_DB_NAME, ACTIVE_NETWORK_KEY } from "./core/storage-namespace";
import type { AppContext } from "./core/app-context";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/\-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function initWebPush(ctx: AppContext) {
  const registerPushBtn = document.getElementById("register-push-btn") as HTMLButtonElement;
  const unregisterPushBtn = document.getElementById("unregister-push-btn") as HTMLButtonElement;
  const pushStatusVal = document.getElementById("push-status-val") as HTMLSpanElement;
  const pushGatewayUrlInput = document.getElementById("push-gateway-url") as HTMLInputElement;
  const simulateOfflinePushBtn = document.getElementById("simulate-offline-push-btn") as HTMLButtonElement;
  const nwcRelayUrlInput = document.getElementById("nwc-relay-url") as HTMLInputElement;

  let swRegistration: ServiceWorkerRegistration | null = null;

  async function initServiceWorker() {
    if ("serviceWorker" in navigator && "PushManager" in window) {
      try {
        appendLog("[SYSTEM] Registering Service Worker...", "system");
        swRegistration = await navigator.serviceWorker.register("/service-worker.js", { type: "module" });
        appendLog("[SYSTEM] Service Worker registered successfully!", "system");

        const subscription = await swRegistration.pushManager.getSubscription();
        if (subscription) {
          pushStatusVal.innerText = "Registered";
          pushStatusVal.className = "value text-success";
          registerPushBtn.disabled = true;
          unregisterPushBtn.disabled = false;
        }
      } catch (e: any) {
        appendLog(`[ERROR] SW registration failed: ${e.message}`, "error");
      }
    } else {
      appendLog("[WARN] Service Worker or Push Notifications are not supported in this browser.", "warn");
      registerPushBtn.disabled = true;
    }
  }

  initServiceWorker();

  registerPushBtn.addEventListener("click", async () => {
    const wallet = ctx.getWallet();
    if (!swRegistration || !wallet) {
      appendLog("[WARN] Start LDK node first to pairing wallet for push registration.", "warn");
      return;
    }

    try {
      registerPushBtn.disabled = true;
      appendLog("[SYSTEM] Requesting notification permission...", "system");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        throw new Error("Notification permission denied");
      }

      const gatewayUrl = pushGatewayUrlInput.value.trim().replace(/\/$/, "");

      appendLog(`[Push] Fetching VAPID public key from ${gatewayUrl}...`, "info");
      const vapidRes = await fetch(`${gatewayUrl}/api/vapid-public-key`);
      if (!vapidRes.ok) throw new Error("Failed to fetch VAPID key");
      const { publicKey: vapidPubKey } = await vapidRes.json();

      appendLog("[Push] Subscribing via browser PushManager...", "info");
      const subscription = await swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPubKey)
      });

      const walletPubkey = wallet.nwc.getWalletPubkey();
      const relayUrl = nwcRelayUrlInput.value.trim();

      appendLog("[Push] Sending subscription details to gateway...", "info");
      const regRes = await fetch(`${gatewayUrl}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletPubkey,
          relayUrl,
          subscription
        })
      });

      if (!regRes.ok) {
        throw new Error("Failed to register subscription with gateway");
      }

      pushStatusVal.innerText = "Registered";
      pushStatusVal.className = "value text-success";
      unregisterPushBtn.disabled = false;
      appendLog("[Push] Web Push Notification wakeup enabled successfully!", "system");

    } catch (err: any) {
      appendLog(`[ERROR] Push registration failed: ${err.message}`, "error");
      registerPushBtn.disabled = false;
    }
  });

  unregisterPushBtn.addEventListener("click", async () => {
    if (!swRegistration) return;
    try {
      unregisterPushBtn.disabled = true;
      const subscription = await swRegistration.pushManager.getSubscription();
      if (subscription) {
        await subscription.unsubscribe();

        const wallet = ctx.getWallet();
        if (wallet) {
          const gatewayUrl = pushGatewayUrlInput.value.trim().replace(/\/$/, "");
          const walletPubkey = wallet.nwc.getWalletPubkey();
          const relayUrl = nwcRelayUrlInput.value.trim();

          await fetch(`${gatewayUrl}/api/unregister`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ walletPubkey, relayUrl })
          });
        }
      }

      pushStatusVal.innerText = "Not Registered";
      pushStatusVal.className = "value text-warning";
      registerPushBtn.disabled = false;
      appendLog("[Push] Web Push Notification un-registered.", "system");

    } catch (err: any) {
      appendLog(`[ERROR] Push unregistration failed: ${err.message}`, "error");
      unregisterPushBtn.disabled = false;
    }
  });

  simulateOfflinePushBtn.addEventListener("click", async () => {
    try {
      simulateOfflinePushBtn.disabled = true;

      const metaStore = new IndexedDBStorageProvider(META_DB_NAME);
      const activeNetwork = (await metaStore.getItem(ACTIVE_NETWORK_KEY)) || "regtest";
      const storage = new IndexedDBStorageProvider(dbNameForNetwork(activeNetwork));
      const connJson = await storage.getItem("nwc_connections");
      const connections = connJson ? JSON.parse(connJson) : [];
      if (connections.length === 0) {
        throw new Error("Create an NWC Connection (Section 7) first to retrieve active keys.");
      }

      const conn = connections[connections.length - 1];
      const clientSecretHex = conn.secret;

      const walletPrivKeyHex = await storage.getItem("nwc_wallet_private_key");
      if (!walletPrivKeyHex) {
        throw new Error("Wallet private key not found in storage. Start the node first.");
      }

      const { getPublicKey: derivePubkey, Relay: NostrRelay, finalizeEvent: nostrFinalize, nip04: nostrNip04 } = await import("nostr-tools");

      const hexToBytesHelper = (hex: string) => {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return bytes;
      };

      const targetPubkey = derivePubkey(hexToBytesHelper(walletPrivKeyHex));
      const relayUrl = conn.relayUrl;

      appendLog(`[Simulate] Connecting to Nostr relay: ${relayUrl} to publish NWC request...`, "info");
      const relay = await NostrRelay.connect(relayUrl);

      const requestPayload = {
        jsonrpc: "2.0",
        id: "sim-request-" + Math.floor(Math.random() * 100000),
        method: "get_balance",
        params: {}
      };

      appendLog("[Simulate] Encrypting NWC get_balance request payload...", "info");
      const encryptedContent = await nostrNip04.encrypt(clientSecretHex, targetPubkey, JSON.stringify(requestPayload));

      const event = {
        kind: 23194,
        tags: [["p", targetPubkey]],
        content: encryptedContent,
        created_at: Math.floor(Date.now() / 1000)
      };

      const finalizedEvent = nostrFinalize(event, hexToBytesHelper(clientSecretHex));

      appendLog(`[Simulate] Publishing kind 23194 request to relay. Event ID: ${finalizedEvent.id}`, "info");
      await relay.publish(finalizedEvent);
      appendLog("[Simulate] Event published successfully! Closing Nostr connection.", "system");
      await relay.close();

      appendLog("[SYSTEM] Simulated NWC request event published to relay. Waking up background Service Worker...", "system");

    } catch (err: any) {
      appendLog(`[ERROR] Simulation failed: ${err.message}`, "error");
    } finally {
      simulateOfflinePushBtn.disabled = false;
    }
  });
}
