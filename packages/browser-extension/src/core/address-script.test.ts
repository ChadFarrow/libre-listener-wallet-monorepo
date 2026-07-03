import { describe, it, expect } from "vitest";
import { addressToScriptPubKey } from "./address-script";

const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");

describe("addressToScriptPubKey", () => {
  it("decodes a P2WPKH (bech32 v0) address to its scriptPubKey (BIP173 vector)", () => {
    expect(hex(addressToScriptPubKey("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"))).toBe(
      "0014751e76e8199196d454941c45d1b3a323f1433bd6"
    );
  });

  it("decodes a P2TR (bech32m v1) address to OP_1 PUSH32 <program>", () => {
    const spk = addressToScriptPubKey("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0");
    expect(spk[0]).toBe(0x51); // OP_1
    expect(spk[1]).toBe(0x20); // push 32 bytes
    expect(spk.length).toBe(34);
  });

  it("is tolerant of surrounding whitespace", () => {
    expect(hex(addressToScriptPubKey("  bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4 "))).toBe(
      "0014751e76e8199196d454941c45d1b3a323f1433bd6"
    );
  });

  it("rejects legacy base58, non-addresses, and empty input", () => {
    expect(() => addressToScriptPubKey("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2")).toThrow();
    expect(() => addressToScriptPubKey("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy")).toThrow();
    expect(() => addressToScriptPubKey("definitely not an address")).toThrow();
    expect(() => addressToScriptPubKey("")).toThrow();
  });
});
