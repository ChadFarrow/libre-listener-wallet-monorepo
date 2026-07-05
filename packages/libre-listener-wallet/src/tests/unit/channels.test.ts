// @vitest-environment node
import { describe, it, expect } from "vitest";
import { mapChannelDetails, sumBalance, ChannelInfo } from "../../index";

// Minimal stub matching the LDK ChannelDetails getters mapChannelDetails uses. txid is little-endian
// (as LDK hands it). get_confirmations()/_required() return a non-Some Option here (the Some path
// needs real LDK WASM to build an Option_u32Z_Some — its output is covered by channelConfLabel's own
// test + live use); this exercises the None/absent branch.
function stubCd(over: Partial<{
  id: number[]; node: number[]; capacity: bigint; outMsat: bigint; inMsat: bigint; usable: boolean; ready: boolean;
  txidLe: number[] | null; fundingIndex: number;
}> = {}) {
  const o = {
    id: [0xab, 0xcd], node: [0x02, 0x11], capacity: 1_000_000n, outMsat: 200_000_000n, inMsat: 800_000_000n,
    usable: true, ready: true, txidLe: null as number[] | null, fundingIndex: 0, ...over,
  };
  return {
    get_channel_id: () => ({ get_a: () => new Uint8Array(o.id) }),
    get_counterparty: () => ({ get_node_id: () => new Uint8Array(o.node) }),
    get_channel_value_satoshis: () => o.capacity,
    get_outbound_capacity_msat: () => o.outMsat,
    get_inbound_capacity_msat: () => o.inMsat,
    get_is_usable: () => o.usable,
    get_is_channel_ready: () => o.ready,
    get_funding_txo: () => ({
      get_txid: () => new Uint8Array(o.txidLe ?? new Array(32).fill(0)),
      get_index: () => o.fundingIndex,
    }),
    get_confirmations: () => ({}), // not an Option_u32Z_Some → optU32 → undefined
    get_confirmations_required: () => ({}),
  } as any;
}

describe("mapChannelDetails", () => {
  it("maps an LDK ChannelDetails to ChannelInfo (msat→sat, bytes→hex); no funding txid when unfunded", () => {
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
    expect(info.fundingTxid).toBeUndefined(); // all-zero txid = not yet funded
  });

  it("maps the funding outpoint to a big-endian display txid (LDK gives it little-endian)", () => {
    const le = new Array(32).fill(0);
    le[0] = 0x11;
    le[31] = 0x22;
    const info = mapChannelDetails(stubCd({ txidLe: le, fundingIndex: 3 }));
    expect(info.fundingTxid).toBe("22" + "00".repeat(30) + "11"); // reversed to display order
    expect(info.fundingOutputIndex).toBe(3);
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
