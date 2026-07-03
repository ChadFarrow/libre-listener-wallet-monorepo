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

// Maps LDK's CounterpartyForwardingInfo wrapper (from ChannelCounterparty.get_forwarding_info())
// into HintableChannel.forwardingInfo, or undefined when the info is genuinely absent.
//
// WHY this exists: in the installed lightningdevkit 0.1.0 WASM bindings, get_forwarding_info()
// ALWAYS returns a truthy JS wrapper object (`new CounterpartyForwardingInfo(null, ret)`) even
// when the underlying Rust Option is None -- the None case is an internal null pointer
// (CommonBase's `ptr` is 0n), and every accessor on a null-ptr wrapper silently returns 0. A
// naive `fwd ? {...} : undefined` check is therefore dead code: a usable channel whose peer
// hasn't yet sent its channel_update would be "hinted" with a FABRICATED fee_base=0/
// fee_prop=0/cltv_delta=0, making the advertised last hop unpayable. Detect the null-ptr case
// directly, and as a belt-and-braces fallback (in case a future binding regen changes the ptr
// field's name/shape), also treat cltv_expiry_delta === 0 as absent -- a real channel_update
// never carries a zero cltv_expiry_delta.
export function forwardingInfoFromLdk(
  fwd:
    | {
        get_fee_base_msat(): number;
        get_fee_proportional_millionths(): number;
        get_cltv_expiry_delta(): number;
      }
    | null
    | undefined
): { feeBaseMsat: number; feeProportionalMillionths: number; cltvExpiryDelta: number } | undefined {
  if (!fwd) return undefined;
  // `ptr` is a protected field on LDK's CommonBase; duck-type through `unknown` to read it
  // without importing the LDK class (this module stays LDK-free / pure).
  const ptr = (fwd as unknown as { ptr?: number | bigint }).ptr;
  if (ptr === undefined || ptr === null || ptr === 0 || ptr === 0n) return undefined;
  const cltvExpiryDelta = fwd.get_cltv_expiry_delta();
  if (cltvExpiryDelta === 0) return undefined;
  return {
    feeBaseMsat: fwd.get_fee_base_msat(),
    feeProportionalMillionths: fwd.get_fee_proportional_millionths(),
    cltvExpiryDelta,
  };
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

// Builds the final hint list for an LSPS2 JIT invoice: the LSP's intercept hint (jit_channel_scid)
// goes FIRST — an external payer must route via that scid to trigger the interceptor, regardless of
// any existing channel's capacity — then capacity-ranked real-channel hints fill the remaining
// slots (deduped by scid, capped at MAX_HINTS). With no priority hint this is just selectHintChannels.
export function prioritizeHints(priority: HintHop | undefined, channels: HintableChannel[]): HintHop[] {
  const capacityHints = selectHintChannels(channels);
  if (!priority) return capacityHints;
  const rest = capacityHints.filter((h) => h.scid !== priority.scid);
  return [priority, ...rest].slice(0, MAX_HINTS);
}
