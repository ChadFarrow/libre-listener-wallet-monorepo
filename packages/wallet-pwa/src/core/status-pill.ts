// Home-screen status pill: surfaces POST-onboarding regressions only (onboarding itself is a
// hard gate — no wallet / incomplete setup never reaches home). Pure and priority-ordered so
// the single most actionable problem shows; tapping deep-links to `target`.

export interface StatusPillInputs {
  hasWallet: boolean;
  running: boolean;
  startError?: string;
  channels: number;
  usableChannels: number;
  driveConfigured: boolean;
  backedUp: boolean;
}

export type StatusPillTarget = "node" | "get-channel" | "channels" | "cloud-backup" | "recovery";

export interface StatusPill {
  level: "bad" | "warn" | "info";
  text: string;
  target: StatusPillTarget;
}

export function statusPill(i: StatusPillInputs): StatusPill | null {
  if (!i.hasWallet) return null; // onboarding owns the no-wallet state

  if (!i.running) {
    return {
      level: "bad",
      text: i.startError ? `Node stopped — ${i.startError}` : "Node stopped — tap to start",
      target: "node",
    };
  }
  if (i.channels === 0) {
    return { level: "warn", text: "No channel yet — get one to receive", target: "get-channel" };
  }
  if (i.usableChannels === 0) {
    return { level: "info", text: "Channel opening — this can take a bit", target: "channels" };
  }
  if (!i.backedUp) {
    return { level: "warn", text: "Back up your wallet seed", target: "recovery" };
  }
  if (!i.driveConfigured) {
    return { level: "warn", text: "Turn on cloud backup", target: "cloud-backup" };
  }
  return null;
}
