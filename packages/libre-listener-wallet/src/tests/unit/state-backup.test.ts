// @vitest-environment node
import { describe, it, expect } from "vitest";
import { serializeAndEncrypt, decryptAndParse, BackupPayload } from "../../state-backup";

const seedHex = "ab".repeat(32); // 32-byte seed
const wrongSeed = "cd".repeat(32);

const payload: BackupPayload = {
  version: 1,
  network: "regtest",
  exportedAt: 1700000000000,
  entries: { ldk_seed: seedHex, channel_manager: "deadbeef", "monitors/x/y": "00ff" },
};

describe("state-backup encrypt/decrypt", () => {
  it("round-trips a payload with the correct seed", async () => {
    const blob = await serializeAndEncrypt(payload, seedHex);
    expect(typeof blob).toBe("string");
    expect(blob).not.toContain("deadbeef"); // must be ciphertext, not plaintext
    const out = await decryptAndParse(blob, seedHex);
    expect(out).toEqual(payload);
  });

  it("rejects the wrong seed", async () => {
    const blob = await serializeAndEncrypt(payload, seedHex);
    await expect(decryptAndParse(blob, wrongSeed)).rejects.toThrow(/wrong seed or corrupt/);
  });

  it("rejects a malformed envelope", async () => {
    await expect(decryptAndParse("not json", seedHex)).rejects.toThrow(/not valid JSON/);
  });

  it("rejects a valid-JSON envelope missing iv/ct", async () => {
    await expect(decryptAndParse(JSON.stringify({ v: 1, alg: "AES-256-GCM", kdf: "HKDF-SHA256" }), seedHex)).rejects.toThrow(/wrong seed or corrupt/);
  });
});
