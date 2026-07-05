// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  seedHexToMnemonic,
  mnemonicToSeedHex,
  isValidSeedMnemonic,
  normalizeMnemonic,
  normalizeBackupSecret,
} from "../../seed-phrase";

// Frozen golden vector — pins the seed<->phrase mapping. If this changes, existing
// users' written-down words stop reconstructing their seed. Do not "fix" by editing
// the expected value; the mapping is BIP39-standard (entropy == the 32-byte seed).
const GOLDEN_SEED_HEX = "1111111111111111111111111111111111111111111111111111111111111111";
const GOLDEN_MNEMONIC =
  "baby mass dust captain baby mass dust captain baby mass dust captain baby mass dust captain baby mass dust captain baby mass dust cake";

describe("seed-phrase: golden vector", () => {
  it("encodes the frozen seed to the frozen 24-word phrase", () => {
    expect(seedHexToMnemonic(GOLDEN_SEED_HEX)).toBe(GOLDEN_MNEMONIC);
  });
  it("decodes the frozen phrase back to the frozen seed", () => {
    expect(mnemonicToSeedHex(GOLDEN_MNEMONIC)).toBe(GOLDEN_SEED_HEX);
  });
});

describe("seed-phrase: round-trip", () => {
  it("round-trips arbitrary 32-byte seeds hex -> phrase -> hex", () => {
    for (const seed of [
      "0".repeat(64),
      "f".repeat(64),
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "deadbeefcafebabe00112233445566778899aabbccddeeff0f1e2d3c4b5a6978",
    ]) {
      const phrase = seedHexToMnemonic(seed);
      expect(phrase.split(" ")).toHaveLength(24);
      expect(mnemonicToSeedHex(phrase)).toBe(seed);
    }
  });
});

describe("seed-phrase: normalization", () => {
  it("accepts messy whitespace and mixed case", () => {
    const messy = `  BABY   mass\tdust\ncaptain baby mass dust captain baby mass dust captain baby mass dust captain baby mass dust captain baby mass dust cake  `;
    expect(normalizeMnemonic(messy)).toBe(GOLDEN_MNEMONIC);
    expect(mnemonicToSeedHex(messy)).toBe(GOLDEN_SEED_HEX);
    expect(isValidSeedMnemonic(messy)).toBe(true);
  });
});

describe("seed-phrase: rejection", () => {
  it("rejects a bad checksum (last word swapped)", () => {
    const bad = GOLDEN_MNEMONIC.replace(/cake$/, "cabbage");
    expect(isValidSeedMnemonic(bad)).toBe(false);
    expect(() => mnemonicToSeedHex(bad)).toThrow(/Invalid recovery phrase/);
  });

  it("rejects an unknown (non-wordlist) word", () => {
    const bad = GOLDEN_MNEMONIC.replace(/^baby/, "zzzznotaword");
    expect(isValidSeedMnemonic(bad)).toBe(false);
    expect(() => mnemonicToSeedHex(bad)).toThrow();
  });

  it("rejects a valid 12-word phrase (not this wallet's 256-bit seed)", () => {
    // A real, checksum-valid 12-word phrase (128-bit) — must be refused for restore.
    const twelve = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    expect(isValidSeedMnemonic(twelve)).toBe(false);
    expect(() => mnemonicToSeedHex(twelve)).toThrow(/24 words/);
  });

  it("rejects non-hex seeds when encoding", () => {
    expect(() => seedHexToMnemonic("not-hex")).toThrow(/64-character hex/);
    expect(() => seedHexToMnemonic("11".repeat(31))).toThrow(/64-character hex/);
  });
});

describe("seed-phrase: normalizeBackupSecret", () => {
  it("converts a valid 24-word phrase to its 64-hex seed", () => {
    expect(normalizeBackupSecret(GOLDEN_MNEMONIC)).toBe(GOLDEN_SEED_HEX);
  });
  it("passes a raw hex seed through unchanged", () => {
    expect(normalizeBackupSecret(GOLDEN_SEED_HEX)).toBe(GOLDEN_SEED_HEX);
  });
  it("passes a passphrase through unchanged", () => {
    expect(normalizeBackupSecret("correct horse battery staple")).toBe("correct horse battery staple");
  });
});
