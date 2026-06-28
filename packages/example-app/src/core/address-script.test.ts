import { describe, it, expect } from "vitest";
import { addressToScriptPubKey } from "./address-script";

const hex = (u: Uint8Array) => Array.from(u).map((b) => b.toString(16).padStart(2, "0")).join("");

describe("addressToScriptPubKey", () => {
  it("decodes a P2WPKH (v0) address (BIP173 vector)", () => {
    expect(hex(addressToScriptPubKey("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")))
      .toBe("0014751e76e8199196d454941c45d1b3a323f1433bd6");
  });

  it("decodes a P2WSH (v0) address", () => {
    expect(hex(addressToScriptPubKey("bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3")))
      .toBe("00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262");
  });

  it("decodes a P2TR (v1) address via bech32m (BIP350 vector)", () => {
    expect(hex(addressToScriptPubKey("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0")))
      .toBe("512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
  });

  it("rejects garbage / unsupported addresses", () => {
    expect(() => addressToScriptPubKey("not-an-address")).toThrow();
    expect(() => addressToScriptPubKey("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2")).toThrow(); // legacy unsupported
  });
});
