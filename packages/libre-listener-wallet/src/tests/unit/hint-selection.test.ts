import { describe, it, expect } from "vitest";
import { selectHintChannels, type HintableChannel } from "../../hint-selection";

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
