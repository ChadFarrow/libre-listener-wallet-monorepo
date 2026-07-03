import { describe, it, expect } from "vitest";
import { selectHintChannels, prioritizeHints, forwardingInfoFromLdk, type HintableChannel } from "../../hint-selection";
import type { HintHop } from "../../bolt11-hints";

const FWD = { feeBaseMsat: 1000, feeProportionalMillionths: 1, cltvExpiryDelta: 80 };
const base: HintableChannel = {
  isUsable: true,
  counterpartyNodeId: "02" + "ab".repeat(32),
  inboundPaymentScid: 111n,
  shortChannelId: 222n,
  inboundCapacityMsat: 90_000_000n,
  forwardingInfo: FWD,
};

describe("selectHintChannels", () => {
  it("maps a usable channel to a hint via the counterparty's real policy, preferring the inbound-payment scid", () => {
    const [hint] = selectHintChannels([base]);
    expect(hint).toEqual({
      srcNodeId: base.counterpartyNodeId,
      scid: 111n,
      feeBaseMsat: 1000,
      feeProportionalMillionths: 1,
      cltvExpiryDelta: 80,
    });
  });

  it("falls back to short_channel_id when no inbound-payment scid exists", () => {
    const [hint] = selectHintChannels([{ ...base, inboundPaymentScid: undefined }]);
    expect(hint.scid).toBe(222n);
  });

  it("drops channels that are unusable, hintless-scid, or missing forwarding info", () => {
    expect(selectHintChannels([{ ...base, isUsable: false }])).toEqual([]);
    expect(selectHintChannels([{ ...base, inboundPaymentScid: undefined, shortChannelId: undefined }])).toEqual([]);
    expect(selectHintChannels([{ ...base, forwardingInfo: undefined }])).toEqual([]);
  });

  it("sorts by inbound capacity desc and caps at 3", () => {
    const mk = (cap: bigint, scid: bigint): HintableChannel => ({ ...base, inboundCapacityMsat: cap, inboundPaymentScid: scid });
    const hints = selectHintChannels([mk(1n, 1n), mk(4n, 4n), mk(3n, 3n), mk(2n, 2n)]);
    expect(hints.map((h) => h.scid)).toEqual([4n, 3n, 2n]);
  });
});

// prioritizeHints places a forced intercept hint (the LSPS2 jit_channel_scid) FIRST, ahead of the
// capacity-ranked real-channel hints — an external payer must route via the LSP's intercept scid,
// not whichever existing channel has the most inbound capacity.
describe("prioritizeHints", () => {
  const PRIORITY: HintHop = {
    srcNodeId: "03" + "ff".repeat(32),
    scid: 999n,
    feeBaseMsat: 0,
    feeProportionalMillionths: 0,
    cltvExpiryDelta: 144,
  };
  const mk = (cap: bigint, scid: bigint): HintableChannel => ({ ...base, inboundCapacityMsat: cap, inboundPaymentScid: scid });

  it("returns the capacity-ranked hints unchanged when there is no priority hint", () => {
    expect(prioritizeHints(undefined, [base])).toEqual(selectHintChannels([base]));
  });

  it("returns just the priority hint when there are no channels", () => {
    expect(prioritizeHints(PRIORITY, [])).toEqual([PRIORITY]);
  });

  it("puts the priority hint first, then capacity-ranked hints, capped at 3", () => {
    const hints = prioritizeHints(PRIORITY, [mk(1n, 1n), mk(3n, 3n), mk(2n, 2n)]);
    expect(hints[0]).toEqual(PRIORITY);
    expect(hints.map((h) => h.scid)).toEqual([999n, 3n, 2n]);
  });

  it("dedups a capacity hint that shares the priority scid", () => {
    const hints = prioritizeHints({ ...PRIORITY, scid: 3n }, [mk(3n, 3n), mk(2n, 2n)]);
    expect(hints.map((h) => h.scid)).toEqual([3n, 2n]);
  });
});

// LDK's get_forwarding_info() always returns a truthy wrapper -- even for LDK's None -- so
// `fwd ? ... : undefined` is dead code. forwardingInfoFromLdk must detect the null-ptr case
// (and, as a belt-and-braces fallback, a zero cltv_expiry_delta) instead of trusting truthiness.
describe("forwardingInfoFromLdk", () => {
  const real = { get_fee_base_msat: () => 1000, get_fee_proportional_millionths: () => 1, get_cltv_expiry_delta: () => 80 };

  it("returns undefined for a null/undefined wrapper", () => {
    expect(forwardingInfoFromLdk(null)).toBeUndefined();
    expect(forwardingInfoFromLdk(undefined)).toBeUndefined();
  });

  it("returns undefined for a truthy wrapper with a null pointer (LDK's None), even though naive truthiness would pass", () => {
    const noneWrapper = { ...real, ptr: 0n };
    expect(noneWrapper).toBeTruthy(); // sanity: this is exactly the trap the naive `fwd ? ... : undefined` fell into
    expect(forwardingInfoFromLdk(noneWrapper)).toBeUndefined();
  });

  it("also treats a numeric zero pointer as absent (bindings may use number, not bigint)", () => {
    expect(forwardingInfoFromLdk({ ...real, ptr: 0 })).toBeUndefined();
  });

  it("belt-and-braces: treats cltv_expiry_delta === 0 as absent even with a nonzero pointer", () => {
    const zeroCltv = { ...real, ptr: 1n, get_cltv_expiry_delta: () => 0 };
    expect(forwardingInfoFromLdk(zeroCltv)).toBeUndefined();
  });

  it("maps a real, present forwarding info to the HintableChannel shape", () => {
    expect(forwardingInfoFromLdk({ ...real, ptr: 1n })).toEqual({
      feeBaseMsat: 1000,
      feeProportionalMillionths: 1,
      cltvExpiryDelta: 80,
    });
  });
});
