import { describe, it, expect } from "vitest";
import { resolveSeedInput } from "./seed-input";

const SEED_HEX = "1111111111111111111111111111111111111111111111111111111111111111";
const PHRASE =
  "baby mass dust captain baby mass dust captain baby mass dust captain baby mass dust captain baby mass dust captain baby mass dust cake";

describe("resolveSeedInput", () => {
  it("returns a raw 64-hex seed unchanged (lowercased)", () => {
    expect(resolveSeedInput(SEED_HEX)).toBe(SEED_HEX);
    expect(resolveSeedInput(SEED_HEX.toUpperCase())).toBe(SEED_HEX);
    expect(resolveSeedInput(`  ${SEED_HEX}  `)).toBe(SEED_HEX);
  });

  it("resolves a 24-word recovery phrase to its 64-hex seed", () => {
    expect(resolveSeedInput(PHRASE)).toBe(SEED_HEX);
    expect(resolveSeedInput(`  ${PHRASE.toUpperCase()}  `)).toBe(SEED_HEX);
  });

  it("tolerates the on-screen spaced hex (highlighted display instead of the Copy button)", () => {
    // How the seed renders: groups of 8 separated by spaces.
    const spaced = SEED_HEX.replace(/(.{8})/g, "$1 ").trim();
    expect(resolveSeedInput(spaced)).toBe(SEED_HEX);
    // Newlines / doubled spaces from a copy shouldn't matter either.
    expect(resolveSeedInput(`${SEED_HEX.slice(0, 32)}\n${SEED_HEX.slice(32)}`)).toBe(SEED_HEX);
  });

  it("resolves a recovery phrase even with newlines / extra spaces between words", () => {
    expect(resolveSeedInput(PHRASE.replace(/ /g, "  "))).toBe(SEED_HEX);
    expect(resolveSeedInput(PHRASE.replace(/ /g, "\n"))).toBe(SEED_HEX);
  });

  it("returns null for garbage / partial / wrong-length input", () => {
    expect(resolveSeedInput("")).toBeNull();
    expect(resolveSeedInput("not a seed")).toBeNull();
    expect(resolveSeedInput("11".repeat(31))).toBeNull(); // 62 hex chars
    expect(resolveSeedInput("legal winner thank year wave sausage worth useful legal winner thank yellow")).toBeNull(); // valid 12-word, wrong length
    expect(resolveSeedInput(PHRASE.replace(/cake$/, "cabbage"))).toBeNull(); // bad checksum
  });
});
