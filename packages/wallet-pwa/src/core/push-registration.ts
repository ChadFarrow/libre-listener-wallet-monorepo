// Offline-wake (Web Push) re-registration policy. iOS silently invalidates a PWA's push
// subscription (across relaunches, OS updates, or just time), after which the gateway deletes the
// stale record on its next 410 send and the device stops receiving wake notifications entirely —
// permanently, until it re-registers. So we persist that the user WANTS wake (independent of the
// fragile pushManager subscription state) and re-subscribe + re-register on every launch/resume.
//
// This module holds only the pure, testable pieces (prefs parse/serialize + the attempt predicate);
// the navigator/fetch side effects live in web-push.ts.

// localStorage key. UI preference — NOT a wallet-DB storage invariant (no storage-contract impact).
export const PUSH_WAKE_PREFS_KEY = "libre_push_wake";

// Defaults the offline-wake UI ships with (kept in sync BY HAND with the #push-gateway-url /
// #push-relay-url input defaults in index.html). Used to backfill prefs for a legacy install that
// enabled wake BEFORE these prefs existed — such a device has a live push subscription but no stored
// prefs, so without this its launch refresh would silently no-op and its gateway registration would
// go stale forever (the exact "wake stopped working" case seen in the field).
export const DEFAULT_PUSH_GATEWAY_URL = "https://nwc-push-gateway-production.up.railway.app";
export const DEFAULT_PUSH_RELAY_URL = "wss://relay.getalby.com/v1";

export interface PushWakePrefs {
  // The endpoints the user actually enabled wake against, so a launch-time refresh reuses them
  // even if the developer-settings inputs later change or the defaults move.
  gatewayUrl: string;
  relayUrl: string;
}

export function serializePushWakePrefs(prefs: PushWakePrefs): string {
  return JSON.stringify({ gatewayUrl: prefs.gatewayUrl, relayUrl: prefs.relayUrl });
}

export function parsePushWakePrefs(raw: string | null): PushWakePrefs | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<PushWakePrefs>;
    if (o && typeof o.gatewayUrl === "string" && typeof o.relayUrl === "string" && o.gatewayUrl && o.relayUrl) {
      return { gatewayUrl: o.gatewayUrl, relayUrl: o.relayUrl };
    }
  } catch {
    /* corrupt value — treat as absent */
  }
  return null;
}

// Whether to attempt a (silent) re-registration now. All four must hold: the user previously
// enabled wake (prefs present); the browser supports push; notification permission is still granted
// (so pushManager.subscribe needs no user gesture — we must NEVER prompt on launch); and the node
// is running (its NWC identity is required to sign the gateway auth). Cheap to call on every start
// transition / resume — it no-ops unless all conditions are met.
export function shouldRefreshPushRegistration(args: {
  prefs: PushWakePrefs | null;
  supported: boolean;
  permission: NotificationPermission;
  running: boolean;
}): boolean {
  return !!args.prefs && args.supported && args.permission === "granted" && args.running;
}

// Actionable guidance when Notification.requestPermission() doesn't return "granted". Two very
// different cases hide behind "not granted", and the fix differs:
//   - "denied": the browser has BLOCKED notifications for this app. A fresh requestPermission() will
//     NOT re-prompt — the user must re-enable notifications in the browser's per-site settings. So
//     telling them "try again" is a dead end; we tell them where to unblock it.
//   - "default" (or anything else): the prompt was dismissed without a choice, so tapping Enable
//     again WILL re-prompt.
// Brave on Android is the common report: it can return "denied" quickly and, even once notifications
// are allowed, needs "Use Google services for push messaging" ON (off by default) for a push
// endpoint to exist — so we name that too.
export function permissionDeniedMessage(permission: NotificationPermission): string {
  if (permission === "denied") {
    return (
      "Notifications are blocked for this app. Unblock them in the browser's site settings " +
      "(tap the address-bar site/lock icon → Permissions → Notifications), then tap Enable again. " +
      "Android web push also needs Google Play Services (Brave: Settings → Privacy → “Use Google " +
      "services for push messaging”), so it can't work on GrapheneOS or de-Googled Android without " +
      "sandboxed Play. Background mode below keeps boosts running without push."
    );
  }
  return "The notification prompt was dismissed. Tap Enable offline wake again and choose Allow.";
}

// Guidance when notification permission WAS granted but the browser still refuses the push
// subscription (pushManager.subscribe throws). Android web push is delivered through Google Play
// Services (FCM), so subscribe() fails when that transport is missing or disabled: Brave ships with
// "Use Google services for push messaging" OFF, and GrapheneOS / de-Googled Android has no Play
// Services at all (sandboxed Play is an optional install). In the de-Googled case NO config fixes
// it — Background mode (keep-alive) is the push-free path.
export function pushSubscribeFailedMessage(): string {
  return (
    "Your browser wouldn't register for push. Android web push needs Google Play Services (Brave: " +
    "enable Settings → Privacy → “Use Google services for push messaging”); it can't work on " +
    "GrapheneOS or de-Googled Android without sandboxed Play. Turn on Background mode below to keep " +
    "boosts settling without push."
  );
}

// Resolve the prefs to refresh against. Stored prefs win. When none exist but the device still has a
// live push subscription, it enabled wake on a build that predated these prefs — backfill the ship
// defaults so the refresh (and thus the gateway registration) keeps working. Returns null when there
// is nothing to act on (never enabled, or the subscription is already gone — nothing to detect).
export function effectivePushPrefs(args: {
  stored: PushWakePrefs | null;
  hasLiveSubscription: boolean;
}): PushWakePrefs | null {
  if (args.stored) return args.stored;
  if (args.hasLiveSubscription) return { gatewayUrl: DEFAULT_PUSH_GATEWAY_URL, relayUrl: DEFAULT_PUSH_RELAY_URL };
  return null;
}
