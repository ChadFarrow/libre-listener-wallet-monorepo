import { describe, it, expect } from "vitest";
import { isAllowedWeblnMethod } from "./webln-gate";

describe("isAllowedWeblnMethod", () => {
  it("allows the WebLN provider surface", () => {
    for (const m of ["enable", "isEnabled", "getInfo", "makeInvoice", "sendPayment", "keysend"]) {
      expect(isAllowedWeblnMethod(m)).toBe(true);
    }
  });

  it("rejects privileged control-plane methods a page must never reach", () => {
    for (const m of [
      "nwcCreateConnection",
      "nwcListConnections",
      "nwcDeleteConnection",
      "exportBackup",
      "createWallet",
      "getRecoveryPhrase",
      "getSeed",
      "restoreWallet",
      "setConfig",
      "getConfig",
      "getState",
      "startNode",
      "stopNode",
      "connectPeer",
      "syncGossip",
      "getBalance",
      "getPayments",
    ]) {
      expect(isAllowedWeblnMethod(m)).toBe(false);
    }
  });

  it("rejects unknown / malformed method names", () => {
    expect(isAllowedWeblnMethod("")).toBe(false);
    expect(isAllowedWeblnMethod("__proto__")).toBe(false);
    expect(isAllowedWeblnMethod("sendPayment ")).toBe(false); // no trimming — exact match only
    expect(isAllowedWeblnMethod(undefined as unknown as string)).toBe(false);
  });
});
