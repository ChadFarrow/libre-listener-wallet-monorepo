// Chooses which channels to advertise as invoice route hints. Pure and LDK-free: the wallet
// maps real ChannelDetails into HintableChannel (see index.ts) so this stays unit-testable.
import type { HintHop } from "./bolt11-hints";

export interface HintableChannel {
  isUsable: boolean;
  counterpartyNodeId: string;
  inboundPaymentScid?: bigint; // LDK's preferred scid for inbound routing (alias-aware)
  shortChannelId?: bigint;
  inboundCapacityMsat: bigint;
  // The counterparty's forwarding policy from its channel_update. Unknowable until the peer's
  // first update arrives; a channel without it cannot be hinted (payers need fee/cltv).
  forwardingInfo?: { feeBaseMsat: number; feeProportionalMillionths: number; cltvExpiryDelta: number };
}

const MAX_HINTS = 3;

export function selectHintChannels(channels: HintableChannel[]): HintHop[] {
  return channels
    .filter((c) => c.isUsable && c.forwardingInfo && (c.inboundPaymentScid ?? c.shortChannelId) !== undefined)
    .sort((a, b) => (b.inboundCapacityMsat > a.inboundCapacityMsat ? 1 : b.inboundCapacityMsat < a.inboundCapacityMsat ? -1 : 0))
    .slice(0, MAX_HINTS)
    .map((c) => ({
      srcNodeId: c.counterpartyNodeId,
      scid: (c.inboundPaymentScid ?? c.shortChannelId)!,
      feeBaseMsat: c.forwardingInfo!.feeBaseMsat,
      feeProportionalMillionths: c.forwardingInfo!.feeProportionalMillionths,
      cltvExpiryDelta: c.forwardingInfo!.cltvExpiryDelta,
    }));
}
