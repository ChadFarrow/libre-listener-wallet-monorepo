import { describe, it, expect } from "vitest";
import { classifySendInput } from "./send-input";

describe("classifySendInput", () => {
  it("classifies a mainnet bolt11 invoice", () => {
    expect(classifySendInput("lnbc10u1pabcdef")).toEqual({ kind: "bolt11", value: "lnbc10u1pabcdef" });
  });

  it("lowercases an uppercase (QR-style) invoice", () => {
    expect(classifySendInput("LNBC10U1PABCDEF")).toEqual({ kind: "bolt11", value: "lnbc10u1pabcdef" });
  });

  it("strips a lightning: URI prefix case-insensitively", () => {
    expect(classifySendInput("lightning:lnbc10u1pabcdef")).toEqual({ kind: "bolt11", value: "lnbc10u1pabcdef" });
    expect(classifySendInput("LIGHTNING:LNBC10U1PABCDEF")).toEqual({ kind: "bolt11", value: "lnbc10u1pabcdef" });
  });

  it("classifies testnet and regtest invoices", () => {
    expect(classifySendInput("lntb10u1pabcdef").kind).toBe("bolt11");
    expect(classifySendInput("lnbcrt10u1pabcdef").kind).toBe("bolt11");
  });

  it("classifies a lightning address", () => {
    expect(classifySendInput("chad@getalby.com")).toEqual({ kind: "lnaddress", value: "chad@getalby.com" });
  });

  it("trims surrounding whitespace", () => {
    expect(classifySendInput("  chad@getalby.com \n")).toEqual({ kind: "lnaddress", value: "chad@getalby.com" });
  });

  it("rejects garbage, empty, and malformed addresses", () => {
    expect(classifySendInput("").kind).toBe("invalid");
    expect(classifySendInput("hello world").kind).toBe("invalid");
    expect(classifySendInput("user@").kind).toBe("invalid");
    expect(classifySendInput("@domain.com").kind).toBe("invalid");
    expect(classifySendInput("bc1qonchainaddress0000000").kind).toBe("invalid");
  });
});
