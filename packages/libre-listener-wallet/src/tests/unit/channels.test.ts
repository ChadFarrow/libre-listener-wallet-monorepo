// @vitest-environment node
import { describe, it, expect } from "vitest";
import { mapChannelDetails, sumBalance, ChannelInfo } from "../../index";

// Minimal stub matching the LDK ChannelDetails getters mapChannelDetails uses.
function stubCd(over: Partial<{
  id: number[]; node: number[]; capacity: bigint; outMsat: bigint; inMsat: bigint; usable: boolean; ready: boolean;
}> = {}) {
  const o = { id: [0xab, 0xcd], node: [0x02, 0x11], capacity: 1_000_000n, outMsat: 200_000_000n, inMsat: 800_000_000n, usable: true, ready: true, ...over };
  return {
    get_channel_id: () => ({ get_a: () => new Uint8Array(o.id) }),
    get_counterparty: () => ({ get_node_id: () => new Uint8Array(o.node) }),
    get_channel_value_satoshis: () => o.capacity,
    get_outbound_capacity_msat: () => o.outMsat,
    get_inbound_capacity_msat: () => o.inMsat,
    get_is_usable: () => o.usable,
    get_is_channel_ready: () => o.ready,
  } as any;
}

describe("mapChannelDetails", () => {
  it("maps an LDK ChannelDetails to ChannelInfo (msat→sat, bytes→hex)", () => {
    const info = mapChannelDetails(stubCd());
    expect(info).toEqual<ChannelInfo>({
      channelId: "abcd",
      counterpartyNodeId: "0211",
      capacitySat: 1_000_000,
      outboundSendableSat: 200_000,
      inboundSat: 800_000,
      isUsable: true,
      isChannelReady: true,
    });
  });
});

describe("sumBalance", () => {
  const ch = (over: Partial<ChannelInfo>): ChannelInfo => ({
    channelId: "x", counterpartyNodeId: "y", capacitySat: 0, outboundSendableSat: 0, inboundSat: 0, isUsable: true, isChannelReady: true, ...over,
  });
  it("sums spendable/receivable over usable channels only", () => {
    const r = sumBalance([
      ch({ outboundSendableSat: 200_000, inboundSat: 800_000, isUsable: true }),
      ch({ outboundSendableSat: 50_000, inboundSat: 10_000, isUsable: false }), // excluded
    ]);
    expect(r).toEqual({ spendableSat: 200_000, receivableSat: 800_000 });
  });
  it("zero for empty / no usable channels", () => {
    expect(sumBalance([])).toEqual({ spendableSat: 0, receivableSat: 0 });
    expect(sumBalance([ch({ outboundSendableSat: 5, isUsable: false })])).toEqual({ spendableSat: 0, receivableSat: 0 });
  });
});
