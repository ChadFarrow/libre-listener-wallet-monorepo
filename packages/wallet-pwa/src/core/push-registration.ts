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
