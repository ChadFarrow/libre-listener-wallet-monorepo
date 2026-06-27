// @vitest-environment node
import { describe, it, expect } from "vitest";
import { serializeAndEncrypt, serializeAndEncryptV1, decryptAndParse, BackupPayload } from "../../state-backup";

const seedHex = "ab".repeat(32); // 64 hex chars
const wrongSeed = "cd".repeat(32);
const passphrase = "correct horse battery staple";

const payload: BackupPayload = {
  version: 1,
  network: "regtest",
  exportedAt: 1700000000000,
  entries: { ldk_seed: seedHex, channel_manager: "deadbeef", "monitors/x/y": "00ff" },
};

describe("state-backup v2 (envelope encryption)", () => {
  it("produces a v2 envelope with passphrase + seed recipients, ciphertext only", async () => {
    const blob = await serializeAndEncrypt(payload, { passphrase, seedHex });
    const env = JSON.parse(blob);
    expect(env.v).toBe(2);
    expect(env.recipients.map((r: { type: string }) => r.type).sort()).toEqual(["passphrase", "seed"]);
    expect(blob).not.toContain("deadbeef"); // must be ciphertext, not plaintext
  });

  it("round-trips when decrypted with the passphrase", async () => {
    const blob = await serializeAndEncrypt(payload, { passphrase, seedHex });
    expect(await decryptAndParse(blob, passphrase)).toEqual(payload);
  });

  it("round-trips when decrypted with the seed (64-hex)", async () => {
    const blob = await serializeAndEncrypt(payload, { passphrase, seedHex });
    expect(await decryptAndParse(blob, seedHex)).toEqual(payload);
  });

  it("fails with the wrong passphrase", async () => {
    const blob = await serializeAndEncrypt(payload, { passphrase, seedHex });
    await expect(decryptAndParse(blob, "nope")).rejects.toThrow(/wrong secret or corrupt/);
  });

  it("fails with the wrong seed", async () => {
    const blob = await serializeAndEncrypt(payload, { passphrase, seedHex });
    await expect(decryptAndParse(blob, wrongSeed)).rejects.toThrow(/wrong secret or corrupt/);
  });

  it("detects tampering of the ciphertext", async () => {
    const env = JSON.parse(await serializeAndEncrypt(payload, { passphrase, seedHex }));
    const ct = Buffer.from(env.ct, "base64");
    ct[0] ^= 0xff;
    env.ct = ct.toString("base64");
    await expect(decryptAndParse(JSON.stringify(env), passphrase)).rejects.toThrow(/wrong secret or corrupt/);
  });

  it("rejects a malformed envelope", async () => {
    await expect(decryptAndParse("not json", passphrase)).rejects.toThrow(/not valid JSON/);
  });

  it("rejects an unsupported version", async () => {
    await expect(decryptAndParse(JSON.stringify({ v: 99 }), passphrase)).rejects.toThrow(/Unsupported backup version/);
  });
});

describe("state-backup v1 backward-compat", () => {
  it("still decrypts a legacy v1 (seed-HKDF) backup", async () => {
    const blob = await serializeAndEncryptV1(payload, seedHex);
    expect(JSON.parse(blob).v).toBe(1);
    expect(await decryptAndParse(blob, seedHex)).toEqual(payload);
  });

  it("rejects a v1 envelope missing iv/ct", async () => {
    await expect(
      decryptAndParse(JSON.stringify({ v: 1, alg: "AES-256-GCM", kdf: "HKDF-SHA256" }), seedHex)
    ).rejects.toThrow(/wrong seed or corrupt/);
  });
});
