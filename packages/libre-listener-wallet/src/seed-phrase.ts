// BIP39 recovery-phrase encoding for the wallet seed.
//
// The wallet seed (`ldk_seed`) is a raw 32-byte value stored as 64 hex chars and
// used DIRECTLY as LDK's `PhantomKeysManager` seed. A BIP39 *24-word* mnemonic
// encodes exactly 256 bits of entropy, so the mnemonic is a pure, reversible
// encoding of that same 32-byte seed — the 32-byte entropy IS the seed. Nothing
// here changes the stored seed format or the backup envelopes; it only lets the
// user record/enter the seed as words instead of hex.
//
// Portability caveat: because LDK uses the entropy as the raw node seed (not a
// BIP32 master key), these words restore THIS wallet (and any wallet that treats
// BIP39 entropy as the raw seed), but a standard HD wallet that runs the words
// through BIP39->BIP32 (LND aezeed, BlueWallet BIP84, ...) derives a different key
// tree. We deliberately keep the raw-seed derivation unchanged.
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { bytesToHex, hexToBytes } from "./storage-cache";

const SEED_HEX_RE = /^[0-9a-fA-F]{64}$/;

/** Normalize a user-typed mnemonic: trim, collapse inner whitespace, lowercase. */
export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Encode a 64-hex (32-byte) LDK seed as a BIP39 24-word recovery phrase. */
export function seedHexToMnemonic(seedHex: string): string {
  if (!SEED_HEX_RE.test(seedHex)) {
    throw new Error("seedHexToMnemonic: expected a 64-character hex seed");
  }
  return entropyToMnemonic(hexToBytes(seedHex), wordlist);
}

/**
 * Decode a BIP39 24-word recovery phrase back to the 64-hex LDK seed.
 * Enforces 256-bit (24-word) entropy — the wallet seed is exactly 32 bytes, so a
 * 12/15/18/21-word phrase cannot be this wallet's seed and is rejected. Throws on
 * a bad checksum, unknown words, or wrong length.
 */
export function mnemonicToSeedHex(mnemonic: string): string {
  const normalized = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(normalized, wordlist)) {
    throw new Error("Invalid recovery phrase — check the words and their order");
  }
  const entropy = mnemonicToEntropy(normalized, wordlist);
  if (entropy.length !== 32) {
    throw new Error("Recovery phrase must be 24 words (256-bit) for this wallet");
  }
  return bytesToHex(entropy);
}

/** True only for a valid 24-word (256-bit) recovery phrase. */
export function isValidSeedMnemonic(input: string): boolean {
  const normalized = normalizeMnemonic(input);
  if (normalized.split(" ").filter(Boolean).length !== 24) return false;
  return validateMnemonic(normalized, wordlist);
}

/**
 * DRY insertion point for backup decryption: if `secret` is a valid 24-word
 * recovery phrase, return the equivalent 64-hex seed; otherwise return it
 * unchanged (a passphrase or a raw hex seed both pass straight through).
 */
export function normalizeBackupSecret(secret: string): string {
  return isValidSeedMnemonic(secret) ? mnemonicToSeedHex(secret) : secret;
}
