import { describe, it, expect, vi } from "vitest";
import { LndLspBackend } from "../backend";
import { JitStore } from "../jit-store";
import type { Lsps2OpeningFeeParams } from "@libre/shared";

const CLIENT = "03clientbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH = "a".repeat(64);

const FEE: Lsps2OpeningFeeParams = {
  opening_fee_params_id: "dev",
  min_fee_msat: "250000",
  proportional_fee_ppm: 1000,
  min_lifetime_blocks: 2016,
  cltv_expiry_delta: 144,
  valid_until: "2100-01-01T00:00:00Z",
};

function mk(over: { findZeroConfAlias?: any } = {}) {
  const store = new JitStore();
  const lnd = {
    getInfo: vi.fn(async () => ({ identity_pubkey: "02lsp" })),
    openZeroConfChannel: vi.fn(async () => {}),
    findZeroConfAlias: over.findZeroConfAlias ?? vi.fn(async () => "778899"),
  } as any;
  const be = new LndLspBackend({ lnd, store, capacitySat: 1_000_000, pushSat: 200_000, feeParams: FEE });
  return { be, lnd, store };
}

describe("LndLspBackend.buy", () => {
  it("opens an instant zero-conf channel, reads the alias, and registers the JIT keyed by it", async () => {
    const { be, lnd, store } = mk();
    const out = await be.buy(CLIENT, HASH);

    expect(lnd.openZeroConfChannel).toHaveBeenCalledWith({ nodePubkeyHex: CLIENT, localFundingSat: 1_000_000, pushSat: 200_000 });
    expect(out.scid).toBe("778899");
    // Registered under the returned alias with the parsed fee params.
    const entry = store.byScid("778899");
    expect(entry).toMatchObject({ clientNodeId: CLIENT, paymentHash: HASH, feeSkimmed: false });
    expect(entry?.feeParams).toEqual({ minFeeMsat: 250_000n, proportionalPpm: 1000 });
  });

  it("getFeeMenu exposes the configured fee params", async () => {
    const { be } = mk();
    expect(be.getFeeMenu()).toEqual([FEE]);
  });
});

describe("LndLspBackend.handleIntercept", () => {
  it("skims the opening fee from the first payment to a bought scid", async () => {
    const { be } = mk();
    await be.buy(CLIENT, HASH);
    const decision = await be.handleIntercept({
      incomingCircuitKey: { chanId: "1", htlcIndex: "0" },
      outgoingRequestedChanId: "778899",
      paymentHash: HASH,
      outgoingAmountMsat: 20_000_000n,
    });
    expect(decision).toEqual({ action: "resume_modified", outAmountMsat: 20_000_000n - 250_000n });
  });

  it("passes through an HTLC for an unknown scid", async () => {
    const { be } = mk();
    const decision = await be.handleIntercept({
      incomingCircuitKey: { chanId: "1", htlcIndex: "0" },
      outgoingRequestedChanId: "000000",
      paymentHash: HASH,
      outgoingAmountMsat: 20_000_000n,
    });
    expect(decision).toEqual({ action: "resume" });
  });
});
