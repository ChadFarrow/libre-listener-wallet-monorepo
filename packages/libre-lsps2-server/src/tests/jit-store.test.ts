import { describe, it, expect } from "vitest";
import { JitStore } from "../jit-store";

const CLIENT = "03clientbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH = "a".repeat(64);
const SCID = "123456789";
const FEE = { minFeeMsat: 250_000n, proportionalPpm: 1000 };

describe("JitStore", () => {
  it("registers an entry retrievable by scid, defaulting feeSkimmed to false", () => {
    const store = new JitStore();
    store.register({ clientNodeId: CLIENT, paymentHash: HASH, scid: SCID, feeParams: FEE });
    const e = store.byScid(SCID);
    expect(e).toMatchObject({ clientNodeId: CLIENT, paymentHash: HASH, scid: SCID, feeParams: FEE, feeSkimmed: false });
  });

  it("retrieves the same entry by payment hash (case-insensitive)", () => {
    const store = new JitStore();
    store.register({ clientNodeId: CLIENT, paymentHash: HASH, scid: SCID, feeParams: FEE });
    expect(store.byPaymentHash(HASH.toUpperCase())?.scid).toBe(SCID);
  });

  it("returns undefined for unknown scid / payment hash", () => {
    const store = new JitStore();
    expect(store.byScid("999")).toBeUndefined();
    expect(store.byPaymentHash("b".repeat(64))).toBeUndefined();
  });

  it("marks an entry skimmed once (byScid reflects it)", () => {
    const store = new JitStore();
    store.register({ clientNodeId: CLIENT, paymentHash: HASH, scid: SCID, feeParams: FEE });
    expect(store.byScid(SCID)?.feeSkimmed).toBe(false);
    store.markSkimmed(SCID);
    expect(store.byScid(SCID)?.feeSkimmed).toBe(true);
  });

  it("markSkimmed on an unknown scid is a safe no-op", () => {
    const store = new JitStore();
    expect(() => store.markSkimmed("nope")).not.toThrow();
  });
});
