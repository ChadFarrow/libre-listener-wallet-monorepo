// Home-screen status pill: surfaces POST-onboarding regressions only (onboarding itself is a
// hard gate — no wallet / incomplete setup never reaches home). Pure and priority-ordered so
// the single most actionable problem shows; tapping deep-links to `target`. Channel state
// comes in as the ONE channelLifecycle derivation (core/channel-lifecycle.ts) — never raw counts.
import type { ChannelLifecycle } from "./channel-lifecycle";

export interface StatusPillInputs {
  hasWallet: boolean;
  running: boolean;
  // A node start is in flight. While true, the "Node stopped" pill is suppressed so it doesn't flash
  // red for the moment between launch and the node coming up.
  starting?: boolean;
  // Within the post-launch settle window (home tracks it). While true, the transient boot pills
  // ("Node stopped", "Cloud backup disconnected") are suppressed: on every launch the node is briefly
  // down and the Drive token is briefly absent (it reconnects on first interaction / via the iOS
  // redirect), and showing each of those for a fraction of a second is the startup "flicker". A real,
  // actionable start error still shows immediately.
  settling?: boolean;
  startError?: string;
  lifecycle: ChannelLifecycle;
  driveConfigured: boolean;
  // Whether Drive has a LIVE token this session. On an installed iOS PWA the silent reconnect can't
  // fire (popups are blocked), so a configured wallet often sits disconnected after a restart with
  // its auto-sync silently dead — surface that so the user can one-tap reconnect (the tap is the
  // trusted gesture the interactive popup needs).
  driveConnected: boolean;
  backedUp: boolean;
}

export type StatusPillTarget =
  | "node"
  | "get-channel"
  | "channels"
  | "cloud-backup"
  | "reconnect-drive"
  | "recovery"
  | "sweep";

export interface StatusPill {
  level: "bad" | "warn" | "info";
  text: string;
  target: StatusPillTarget;
}

export function statusPill(i: StatusPillInputs): StatusPill | null {
  if (!i.hasWallet) return null; // onboarding owns the no-wallet state

  if (!i.running) {
    // Booting: a start is in flight, or we're still inside the post-launch settle window. Stay quiet
    // rather than flash the red "stopped" pill for the fraction of a second before the node is up. A
    // genuine start error is always actionable, so it surfaces immediately regardless.
    if (!i.startError && (i.starting || i.settling)) return null;
    return {
      level: "bad",
      text: i.startError ? `Node stopped — ${i.startError}` : "Node stopped — tap to start",
      target: "node",
    };
  }
  switch (i.lifecycle) {
    case "closed-needs-address":
      return { level: "bad", text: "Channel closed — set a recovery address to get your funds", target: "sweep" };
    case "closed-recovering":
      return { level: "info", text: "Channel closed — recovering your funds on-chain", target: "sweep" };
    case "closed-recovered":
      return { level: "warn", text: "Channel closed — get a new one", target: "get-channel" };
    case "none":
      return { level: "warn", text: "No channel yet — get one to receive", target: "get-channel" };
    case "opening":
      return { level: "info", text: "Channel opening — this can take a bit", target: "channels" };
    case "active":
      break;
  }
  if (!i.backedUp) {
    return { level: "warn", text: "Back up your wallet seed", target: "recovery" };
  }
  if (!i.driveConfigured) {
    return { level: "warn", text: "Turn on cloud backup", target: "cloud-backup" };
  }
  // Configured but the token isn't live (typically an iOS PWA where silent reconnect can't run) —
  // auto-sync is dead until reconnected. Nag with a one-tap reconnect instead of failing silently.
  if (!i.driveConnected) {
    // The Drive token is in-memory, so it's always absent right after launch and reconnects a beat
    // later (first interaction / iOS redirect). Don't nag during the settle window — only once it's
    // clearly not coming back on its own.
    if (i.settling) return null;
    return { level: "warn", text: "Cloud backup disconnected — tap to reconnect", target: "reconnect-drive" };
  }
  return null;
}
