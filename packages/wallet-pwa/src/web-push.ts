// Web Push registration for offline NWC wake-ups. When the PWA is closed/backgrounded, the push
// gateway wakes the service worker (service-worker.ts) to boot a headless node and service one NWC
// request. This is CORE to mobile usefulness: a browser node can't stay alive in the background, so
// push is the only way a "sleeping" wallet answers a pay/balance request. iOS fires push only when
// the PWA is installed to the home screen (iOS 16.4+); Android is more reliable.
import type { WalletController } from "./wallet-controller";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}

async function swRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  return (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.ready);
}

export async function pushSupported(): Promise<boolean> {
  return "serviceWorker" in navigator && "PushManager" in window;
}

export async function isPushEnabled(): Promise<boolean> {
  const reg = await swRegistration();
  if (!reg) return false;
  return !!(await reg.pushManager.getSubscription());
}

// Subscribe this device to offline wake-ups via the gateway. Requires a running node (the gateway
// registers against the NWC wallet pubkey).
export async function enablePush(
  ctx: { controller: WalletController },
  gatewayUrl: string,
  relayUrl: string
): Promise<void> {
  const reg = await swRegistration();
  if (!reg) throw new Error("Push notifications aren't supported in this browser.");
  const walletPubkey = ctx.controller.walletPubkeyForPush();
  if (!walletPubkey) throw new Error("Start the node first so it has an NWC identity to register.");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was denied.");

  const base = gatewayUrl.trim().replace(/\/$/, "");
  const vapidRes = await fetch(`${base}/api/vapid-public-key`);
  if (!vapidRes.ok) throw new Error("Could not fetch the gateway's VAPID key.");
  const { publicKey } = await vapidRes.json();

  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  });

  const regRes = await fetch(`${base}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletPubkey, relayUrl: relayUrl.trim(), subscription }),
  });
  if (!regRes.ok) throw new Error("The gateway rejected the subscription.");
}

export async function disablePush(
  ctx: { controller: WalletController },
  gatewayUrl: string,
  relayUrl: string
): Promise<void> {
  const reg = await swRegistration();
  if (!reg) return;
  const subscription = await reg.pushManager.getSubscription();
  if (!subscription) return;
  await subscription.unsubscribe();
  const walletPubkey = ctx.controller.walletPubkeyForPush();
  if (walletPubkey) {
    const base = gatewayUrl.trim().replace(/\/$/, "");
    await fetch(`${base}/api/unregister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletPubkey, relayUrl: relayUrl.trim() }),
    }).catch(() => {});
  }
}
