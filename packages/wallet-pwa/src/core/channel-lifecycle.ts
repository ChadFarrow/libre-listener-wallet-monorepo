// The app models ONE channel per user: the wallet is always in exactly one phase of a
// single channel lifecycle. Every channel-related surface (status pill, onboarding gate,
// channels screen, home hero, history) consumes THIS derivation — never re-infers.
// Pure + DOM-free. Only meaningful while the node runs (callers gate on `running` first,
// same as today's pill); close/sweep inputs are storage-backed so they survive restarts.

export type ChannelLifecycle =
  | "none" // never had a channel (or a pre-close-records wallet)
  | "opening" // channel exists, not usable yet (also covers peer-offline — counts can't tell)
  | "active"
  | "closed-needs-address" // funds claimable, no recovery address set — actionable
  | "closed-recovering" // sweep queued/broadcasting
  | "closed-recovered"; // close on record, nothing pending — ready for a new channel

export interface LifecycleInputs {
  channels: number;
  usableChannels: number;
  closeCount: number;
  sweepNeedsAddress: boolean;
  sweepPendingCount: number;
}

export function channelLifecycle(i: LifecycleInputs): ChannelLifecycle {
  if (i.channels > 0) return i.usableChannels > 0 ? "active" : "opening";
  // Sweep signals count even without a close record — the SpendableOutputs event can
  // land before (or without) the close record on older wallets.
  if (i.sweepNeedsAddress) return "closed-needs-address";
  if (i.sweepPendingCount > 0) return "closed-recovering";
  if (i.closeCount > 0) return "closed-recovered";
  return "none";
}
