// Decide whether an offline-wake push should raise a "tap to open" notification.
//
// Suppress the notification ONLY when a window is actually VISIBLE — then the foreground node is
// live and settling the NWC request itself, so a notification would be noise. A merely-EXISTING
// window is NOT enough: on iOS a backgrounded PWA is frozen (its node suspended, relay socket dead)
// yet still shows up as a window client. The old "any client → suppress" check therefore swallowed
// the notification AND nothing processed the boost until the user reopened the app — the exact
// "no notification, payments didn't start until I switched to the PWA" symptom. Treat hidden /
// frozen / prerender clients as "not handling it" and notify.
export function shouldNotifyForPush(clientVisibilityStates: string[]): boolean {
  return !clientVisibilityStates.includes("visible");
}
