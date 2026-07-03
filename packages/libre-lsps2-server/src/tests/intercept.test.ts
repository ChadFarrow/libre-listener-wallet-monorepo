import { describe, it, expect } from "vitest";
import { decideIntercept } from "../intercept";
import type { InterceptRequest } from "../intercept-types";
import { JitStore } from "../jit-store";

const CLIENT = "03clientbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH = "a".repeat(64);
const SCID = "123456789";
const FEE = { minFeeMsat: 250_000n, proportionalPpm: 1000 };

function req(over: Partial<InterceptRequest> = {}): InterceptRequest {
  return {
    incomingCircuitKey: { chanId: "1", htlcIndex: "0" },
    outgoingRequestedChanId: SCID,
    paymentHash: HASH,
    outgoingAmountMsat: 20_000_000n,
    ...over,
  };
}

function storeWith(): JitStore {
  const s = new JitStore();
  s.register({ clientNodeId: CLIENT, paymentHash: HASH, scid: SCID, feeParams: FEE });
  return s;
}

describe("decideIntercept", () => {
  it("resumes (passes through) an HTLC for an unknown scid — not one of ours", () => {
    const store = new JitStore();
    expect(decideIntercept(req(), store)).toEqual({ action: "resume" });
  });

  it("resumes when the scid is registered but the payment hash does not match", () => {
    const store = storeWith();
    expect(decideIntercept(req({ paymentHash: "b".repeat(64) }), store)).toEqual({ action: "resume" });
  });

  it("resumes without re-skimming once the opening fee has already been taken", () => {
    const store = storeWith();
    store.markSkimmed(SCID);
    expect(decideIntercept(req(), store)).toEqual({ action: "resume" });
  });

  it("fails the HTLC when the opening fee would consume the whole payment", () => {
    const store = new JitStore();
    store.register({ clientNodeId: CLIENT, paymentHash: HASH, scid: SCID, feeParams: { minFeeMsat: 30_000_000n, proportionalPpm: 0 } });
    expect(decideIntercept(req({ outgoingAmountMsat: 20_000_000n }), store)).toEqual({ action: "fail" });
  });

  it("skims the opening fee once: resume_modified with amount minus fee, then marks it skimmed", () => {
    const store = storeWith();
    // fee = max(250000, ceil(20_000_000*1000/1e6)) = max(250000, 20000) = 250000
    const decision = decideIntercept(req(), store);
    expect(decision).toEqual({ action: "resume_modified", outAmountMsat: 20_000_000n - 250_000n });
    expect(store.byScid(SCID)?.feeSkimmed).toBe(true);
    // a second HTLC on the same channel forwards at full value
    expect(decideIntercept(req(), store)).toEqual({ action: "resume" });
  });
});
