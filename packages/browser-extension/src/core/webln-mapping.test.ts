import { describe, it, expect, vi } from "vitest";
import {
  handleWeblnRequest,
  normalizeMakeInvoice,
  normalizeKeysend,
  normalizeSendPayment,
  spendAmountSats,
  WeblnError,
  type WalletRpc,
} from "./webln-mapping";

function mockRpc(overrides: Partial<WalletRpc> = {}): WalletRpc {
  return {
    getInfo: vi.fn(async () => ({ pubkey: "02aa", alias: "Libre", network: "mainnet" })),
    getBalanceSats: vi.fn(async () => 1234),
    makeInvoice: vi.fn(async () => ({ paymentRequest: "lnbc1..." })),
    payInvoice: vi.fn(async () => ({ preimage: "beef" })),
    keysend: vi.fn(async () => ({ preimage: "cafe" })),
    ...overrides,
  };
}

const DEST = "02" + "b".repeat(64); // 66-hex node pubkey

describe("normalizeMakeInvoice", () => {
  it("accepts a bare number of sats", () => {
    expect(normalizeMakeInvoice(1000)).toEqual({ amountSats: 1000, memo: "", expirySeconds: 3600 });
  });
  it("accepts an object with amount + defaultMemo + expiry", () => {
    expect(normalizeMakeInvoice({ amount: 500, defaultMemo: "coffee", expiry: 600 })).toEqual({
      amountSats: 500,
      memo: "coffee",
      expirySeconds: 600,
    });
  });
  it("rejects non-positive / non-integer amounts", () => {
    expect(() => normalizeMakeInvoice(0)).toThrow(WeblnError);
    expect(() => normalizeMakeInvoice(-5)).toThrow(WeblnError);
    expect(() => normalizeMakeInvoice(1.5)).toThrow(WeblnError);
    expect(() => normalizeMakeInvoice(null)).toThrow(WeblnError);
  });
});

describe("normalizeKeysend", () => {
  it("maps destination + amount + numeric-keyed customRecords (values kept as UTF-8 strings)", () => {
    const out = normalizeKeysend({
      destination: DEST,
      amount: 2100,
      customRecords: { "7629169": '{"podcast":"x"}' },
    });
    expect(out.destination).toBe(DEST);
    expect(out.amountSats).toBe(2100);
    // bLIP-10 TLV 7629169 is UTF-8 JSON, NOT hex — value must pass through unchanged.
    expect(out.customRecords[7629169]).toBe('{"podcast":"x"}');
  });
  it("rejects a bad pubkey", () => {
    expect(() => normalizeKeysend({ destination: "nothex", amount: 1 })).toThrow(WeblnError);
    expect(() => normalizeKeysend({ destination: "04" + "b".repeat(64), amount: 1 })).toThrow(WeblnError);
  });
  it("rejects a non-integer TLV type", () => {
    expect(() => normalizeKeysend({ destination: DEST, amount: 1, customRecords: { foo: "x" } })).toThrow(WeblnError);
  });
});

describe("normalizeSendPayment", () => {
  it("accepts a bare bolt11 string and an object form", () => {
    expect(normalizeSendPayment("lnbc123")).toBe("lnbc123");
    expect(normalizeSendPayment({ paymentRequest: " lnbc456 " })).toBe("lnbc456");
  });
  it("rejects empty input", () => {
    expect(() => normalizeSendPayment("")).toThrow(WeblnError);
    expect(() => normalizeSendPayment({})).toThrow(WeblnError);
  });
});

describe("spendAmountSats", () => {
  it("returns the keysend amount and 0 for sendPayment (decoded downstream)", () => {
    expect(spendAmountSats("keysend", { amount: 777 })).toBe(777);
    expect(spendAmountSats("sendPayment", "lnbc1...")).toBe(0);
  });
});

describe("handleWeblnRequest dispatch", () => {
  it("getInfo shapes a WebLN GetInfoResponse", async () => {
    const rpc = mockRpc();
    const res = await handleWeblnRequest(rpc, "getInfo", undefined);
    expect(res.node.pubkey).toBe("02aa");
    expect(res.methods).toContain("keysend");
  });

  it("makeInvoice returns { paymentRequest }", async () => {
    const rpc = mockRpc();
    const res = await handleWeblnRequest(rpc, "makeInvoice", 1000);
    expect(rpc.makeInvoice).toHaveBeenCalledWith({ amountSats: 1000, memo: "", expirySeconds: 3600 });
    expect(res).toEqual({ paymentRequest: "lnbc1..." });
  });

  it("sendPayment forwards the bolt11 and returns { preimage }", async () => {
    const rpc = mockRpc();
    const res = await handleWeblnRequest(rpc, "sendPayment", "lnbc9");
    expect(rpc.payInvoice).toHaveBeenCalledWith("lnbc9");
    expect(res).toEqual({ preimage: "beef" });
  });

  it("keysend forwards normalized args and returns { preimage }", async () => {
    const rpc = mockRpc();
    const res = await handleWeblnRequest(rpc, "keysend", { destination: DEST, amount: 5 });
    expect(rpc.keysend).toHaveBeenCalledWith({ destination: DEST, amountSats: 5, customRecords: {} });
    expect(res).toEqual({ preimage: "cafe" });
  });

  it("rejects an unsupported method", async () => {
    await expect(handleWeblnRequest(mockRpc(), "signMessage", {})).rejects.toThrow(WeblnError);
  });
});
