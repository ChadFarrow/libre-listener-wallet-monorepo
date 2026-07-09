// Guided setup checklist for the Wallet tab. Pure decision logic (no DOM, no controller) so it's
// unit-testable; the view supplies live state from getState() + the localStorage backup marker and
// renders the returned items.
//
// The gap this closes: a brand-new wallet can Receive on the Wallet tab, but the step that makes
// receiving actually work — getting an inbound channel from an LSP — is buried in Settings with no
// prompt. This checklist walks the user create → back up → start → get a channel, auto-checking each.

// Per-network marker: each network is a separate wallet, so a backup on mainnet must not tick the
// box for a testnet wallet. Kept in localStorage (app-layer UI state, never on-disk wallet state).
export function seedBackedUpKey(network: string): string {
  return `libre_seed_backed_up:${network}`;
}

export function getSeedBackedUp(network: string): boolean {
  try {
    return localStorage.getItem(seedBackedUpKey(network)) === "1";
  } catch {
    return false;
  }
}

export function setSeedBackedUp(network: string): void {
  try {
    localStorage.setItem(seedBackedUpKey(network), "1");
  } catch {
    // localStorage can throw in private mode / disabled storage — the checklist just stays visible.
  }
}

export type ChecklistStepKey = "create" | "backup" | "cloudBackup" | "start" | "channel";

export interface ChecklistItem {
  key: ChecklistStepKey;
  label: string;
  done: boolean;
  active: boolean; // the single current step (first incomplete) — carries the action button
  note?: string; // muted sub-line (e.g. "Channel opening…")
  actionLabel?: string; // present on the active step (and the funded-but-unbacked backup nag)
  actionDisabled?: boolean; // action shown but not yet usable (e.g. get-a-channel before node runs)
}

export interface ChecklistInputs {
  hasWallet: boolean;
  backedUp: boolean;
  cloudBackup: boolean; // Google Drive backup configured — MANDATORY before getting a channel
  running: boolean;
  channels: number; // total channels (pending counts) — 0 when the node is stopped/unknown
  usableChannels: number; // channels ready to route
}

export interface Checklist {
  items: ChecklistItem[];
  visible: boolean;
}

// Order matters: create → back up → start → get a channel. The first incomplete step is "active".
export function computeChecklist(i: ChecklistInputs): Checklist {
  const hasChannel = i.channels > 0;

  const create: ChecklistItem = {
    key: "create",
    label: "Create your wallet",
    done: i.hasWallet,
    active: false,
  };

  const backup: ChecklistItem = {
    key: "backup",
    label: "Back up your recovery phrase",
    done: i.backedUp,
    active: false,
    actionLabel: "Show recovery phrase",
  };

  const cloudBackup: ChecklistItem = {
    key: "cloudBackup",
    label: "Turn on cloud backup (Google Drive)",
    done: i.cloudBackup,
    active: false,
    actionLabel: "Connect Google Drive",
    note: "Required before you get a channel — it's the only way to restore channel funds if you lose this device.",
  };

  const start: ChecklistItem = {
    key: "start",
    label: "Start the node",
    done: i.running,
    active: false,
    actionLabel: "Start node",
  };

  const channel: ChecklistItem = {
    key: "channel",
    label: "Get a channel (inbound liquidity)",
    done: hasChannel,
    active: false,
    actionLabel: "Get a channel",
    // Needs a live node AND a cloud backup destination — a channel opened with no backup can't be
    // recovered if the device is lost. Show the action but disable it until both are satisfied.
    actionDisabled: !i.running || !i.cloudBackup,
  };
  if (hasChannel && i.usableChannels === 0) {
    channel.note = "Channel opening — this can take a bit.";
  } else if (!i.cloudBackup) {
    channel.note = "Turn on cloud backup first.";
  } else if (!i.running) {
    channel.note = "Start the node first.";
  }

  const items = [create, backup, cloudBackup, start, channel];

  // The active step is the first incomplete one (create is done whenever the card shows).
  const firstIncomplete = items.find((it) => !it.done);
  if (firstIncomplete) firstIncomplete.active = true;

  // Show the card while the wallet still needs the essentials: recovery-phrase backup, a cloud
  // backup destination, AND a channel. Any missing one keeps the card up (a funded-but-unbacked
  // wallet keeps nagging — funds are at risk); a fully-set-up wallet hides it entirely.
  const visible = i.hasWallet && !(i.backedUp && i.cloudBackup && hasChannel);

  return { items, visible };
}
