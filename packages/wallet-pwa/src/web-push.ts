// Web Push registration for offline NWC wake-ups. When the PWA is closed/backgrounded, the push
// gateway wakes the service worker (service-worker.ts) to boot a headless node and service one NWC
// request. This is CORE to mobile usefulness: a browser node can't stay alive in the background, so
// push is the only way a "sleeping" wallet answers a pay/balance request. iOS fires push only when
// the PWA is installed to the home screen (iOS 16.4+); Android is more reliable.
import type { WalletController } from "./wallet-controller";
import {
  PUSH_WAKE_PREFS_KEY,
  parsePushWakePrefs,
  serializePushWakePrefs,
  shouldRefreshPushRegistration,
  effectivePushPrefs,
} from "./core/push-registration";

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
  // Fail before prompting for notifications if there's no NWC identity to register.
  if (!ctx.controller.walletPubkeyForPush()) {
    throw new Error("Start the node first so it has an NWC identity to register.");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was denied.");

  await subscribeAndRegister(ctx, reg, gatewayUrl, relayUrl);

  // Remember that the user wants wake, with the endpoints they chose, so the launch/resume refresh
  // can heal a dropped subscription later without another manual toggle.
  try {
    localStorage.setItem(PUSH_WAKE_PREFS_KEY, serializePushWakePrefs({ gatewayUrl: gatewayUrl.trim(), relayUrl: relayUrl.trim() }));
  } catch {
    /* localStorage unavailable — the subscription still works this session */
  }
}

// The shared subscribe → register core (no permission prompt; the caller ensures permission). Fetches
// the gateway VAPID key, subscribes (idempotent — returns the existing subscription if one exists for
// the same key), signs the push-auth, and registers the endpoint. The gateway upserts by endpoint, so
// re-running this refreshes a stale record and re-adds this wallet's pubkey to the live relay sub.
async function subscribeAndRegister(
  ctx: { controller: WalletController },
  reg: ServiceWorkerRegistration,
  gatewayUrl: string,
  relayUrl: string
): Promise<void> {
  const walletPubkey = ctx.controller.walletPubkeyForPush();
  if (!walletPubkey) throw new Error("Start the node first so it has an NWC identity to register.");

  const base = gatewayUrl.trim().replace(/\/$/, "");
  const vapidRes = await fetch(`${base}/api/vapid-public-key`);
  if (!vapidRes.ok) throw new Error("Could not fetch the gateway's VAPID key.");
  const { publicKey } = await vapidRes.json();

  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  });

  // Prove control of walletPubkey, bound to this exact relay + endpoint, so the gateway won't
  // register someone else's endpoint under this wallet's (public) pubkey.
  const auth = ctx.controller.buildGatewayAuth("register", relayUrl.trim(), subscription.endpoint);
  const regRes = await fetch(`${base}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletPubkey, relayUrl: relayUrl.trim(), subscription, auth }),
  });
  if (!regRes.ok) throw new Error("The gateway rejected the subscription.");
}

// Launch/resume re-registration. iOS silently invalidates the push subscription, after which the
// gateway deletes the stale row on its next 410 and this device gets NO more wake notifications
// until it re-registers — the "background wake stopped working" failure. Called on every node
// start-transition and foreground resume: it re-subscribes (healing a dropped subscription) and
// re-registers with the gateway, refreshing its record. Fully best-effort and SILENT — it never
// prompts (permission must already be granted) and never throws into the caller. No-op unless the
// user previously enabled wake and everything needed is in place.
export async function refreshPushRegistration(ctx: { controller: WalletController }): Promise<void> {
  const supported = await pushSupported();
  const permission = typeof Notification !== "undefined" ? Notification.permission : "denied";
  if (!supported || permission !== "granted" || !ctx.controller.isRunning()) return;

  const reg = await swRegistration();
  if (!reg) return;

  // Resolve prefs: stored wins; else backfill the ship defaults if a live subscription proves wake
  // was enabled on a pre-prefs build (legacy migration). Persist a backfill so it's a one-time thing.
  let prefs = parsePushWakePrefs(localStorage.getItem(PUSH_WAKE_PREFS_KEY));
  if (!prefs) {
    const hasLiveSubscription = !!(await reg.pushManager.getSubscription());
    const backfilled = effectivePushPrefs({ stored: null, hasLiveSubscription });
    if (backfilled) {
      prefs = backfilled;
      try {
        localStorage.setItem(PUSH_WAKE_PREFS_KEY, serializePushWakePrefs(prefs));
      } catch {
        /* localStorage unavailable — proceed with the in-memory backfill this session */
      }
      console.log("[Push] backfilled offline-wake prefs from a pre-prefs install");
    }
  }

  if (!shouldRefreshPushRegistration({ prefs, supported, permission, running: true })) return;

  try {
    await subscribeAndRegister(ctx, reg, prefs!.gatewayUrl, prefs!.relayUrl);
    console.log("[Push] re-registered offline-wake subscription with the gateway");
  } catch (e) {
    console.warn("[Push] launch re-registration failed:", (e as Error)?.message || e);
  }
}

export async function disablePush(
  ctx: { controller: WalletController },
  gatewayUrl: string,
  relayUrl: string
): Promise<void> {
  // Clear the wake intent first so the launch/resume refresh can't silently re-register after this.
  try {
    localStorage.removeItem(PUSH_WAKE_PREFS_KEY);
  } catch {
    /* localStorage unavailable — best-effort */
  }
  const reg = await swRegistration();
  if (!reg) return;
  const subscription = await reg.pushManager.getSubscription();
  if (!subscription) return;
  await subscription.unsubscribe();
  const walletPubkey = ctx.controller.walletPubkeyForPush();
  if (walletPubkey) {
    const base = gatewayUrl.trim().replace(/\/$/, "");
    let auth: unknown;
    try {
      auth = ctx.controller.buildGatewayAuth("unregister", relayUrl.trim());
    } catch {
      auth = undefined; // node stopped — best-effort; the gateway will reject an unsigned request
    }
    await fetch(`${base}/api/unregister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletPubkey, relayUrl: relayUrl.trim(), auth }),
    }).catch(() => {});
  }
}
