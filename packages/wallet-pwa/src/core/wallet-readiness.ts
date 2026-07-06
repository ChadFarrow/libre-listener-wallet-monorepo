// Safety guard for starting the LDK node. The dangerous state: a seed is present but the
// channel state (channel_manager + monitors) is missing — e.g. a seed pasted/injected
// without a completed restore. Starting + connecting to the peer in that state makes the
// node reply "I don't know this channel", which FORCE-CLOSES the channel. So a seed
// without channel state is only safe if the wallet was *intentionally* created fresh here.

export interface WalletStartState {
  hasSeed: boolean;          // ldk_seed present in storage
  hasChannelState: boolean;  // channel_manager present in storage (any channel count)
  createdNew: boolean;       // provenance: this seed was created as a brand-new wallet here
}

export interface StartReadiness {
  canStart: boolean;    // safe to start/auto-start the node
  needsRestore: boolean; // a seed exists but its channel state is missing & unaccounted for
  message?: string;
}

export function assessStartReadiness(s: WalletStartState): StartReadiness {
  if (!s.hasSeed) return { canStart: false, needsRestore: false };
  if (s.hasChannelState) return { canStart: true, needsRestore: false };
  if (s.createdNew) return { canStart: true, needsRestore: false };
  return {
    canStart: false,
    needsRestore: true,
    message:
      "Channel state is missing for this wallet. Restore from Drive or a backup file before " +
      "starting — starting now could force-close your channels.",
  };
}
