// Offline-wake (Web Push) notification decision. iOS/WebKit REQUIRES the service worker to show a
// visible notification for every push it handles while no window is visible — repeated "silent"
// pushes (handling a push without a notification) get the push subscription REVOKED, which quietly
// kills offline wake after a few boosts. So the offline-wake path must end in exactly one
// showNotification on EVERY outcome. This maps the outcome → the notification to show. Pure +
// tested; the service worker applies it.

export type OfflineWakeOutcome =
  | { kind: "settled"; method?: string }
  | { kind: "failed"; method?: string; error?: string }
  | { kind: "timeout" };

export interface WakeNotification {
  title: string;
  body: string;
  tag: string;
}

export function offlineWakeNotification(outcome: OfflineWakeOutcome): WakeNotification {
  switch (outcome.kind) {
    case "settled":
      return {
        title: "Payment sent",
        body: "A Lightning payment was completed while the app was closed.",
        tag: "nwc-payment-sent",
      };
    case "failed":
      return {
        title: "Payment didn't go through",
        // Keep the reason if we have one — it's the difference between "try again" and "it's stuck".
        body: outcome.error
          ? `Couldn't complete the request: ${outcome.error}. Tap to open.`
          : "Couldn't complete an offline payment. Tap to open the wallet.",
        tag: "nwc-payment-failed",
      };
    case "timeout":
      return {
        title: "Libre Listener Wallet",
        body: "A payment request is pending. Tap to open and authorize it.",
        tag: "nwc-payment-pending",
      };
  }
}
