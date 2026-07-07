import { describe, it, expect } from "vitest";
import { parseSeedHex, bytesToHex, hexToBytes } from "../../storage-cache";

describe("bytesToHex (lookup-table encoder)", () => {
  it("encodes every byte value correctly (0x00–0xff), zero-padded", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    const hex = bytesToHex(all);
    expect(hex.length).toBe(512);
    expect(hex.slice(0, 6)).toBe("000102");
    expect(hex.slice(-6)).toBe("fdfeff");
  });
  it("round-trips through hexToBytes", () => {
    const bytes = new Uint8Array([0, 15, 16, 127, 128, 255, 42]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });
  it("returns an empty string for empty input", () => {
    expect(bytesToHex(new Uint8Array(0))).toBe("");
  });
});

describe("parseSeedHex", () => {
  const validSeed = "a".repeat(64);

  it("parses a valid 64-hex seed into 32 bytes and round-trips", () => {
    const bytes = parseSeedHex(validSeed);
    expect(bytes).toHaveLength(32);
    expect(bytesToHex(bytes)).toBe(validSeed);
  });

  it("accepts upper-case hex", () => {
    expect(parseSeedHex("A".repeat(64))).toHaveLength(32);
  });

  it("throws on a too-short seed rather than silently truncating", () => {
    expect(() => parseSeedHex("abcd")).toThrow(/malformed/i);
  });

  it("throws on a same-length non-hex value (would derive a different node identity)", () => {
    // 64 chars but contains non-hex — hexToBytes would coerce 'z' to NaN→0 and derive wrong keys.
    expect(() => parseSeedHex("z".repeat(64))).toThrow(/malformed/i);
  });

  it("throws on an empty seed", () => {
    expect(() => parseSeedHex("")).toThrow(/malformed/i);
  });
});
