import { isValidSeedMnemonic, mnemonicToSeedHex } from "@libre/listener-wallet";

const SEED_HEX_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Resolve a user-entered recovery secret to the canonical 64-hex LDK seed.
 * Accepts EITHER a 24-word BIP39 recovery phrase OR a raw 64-hex seed, so the
 * Seed field and restore flow work with whichever the user has written down.
 * Returns lowercase 64-hex, or null if the input is neither.
 */
export function resolveSeedInput(value: string): string | null {
  const trimmed = value.trim();
  if (SEED_HEX_RE.test(trimmed)) return trimmed.toLowerCase();
  if (isValidSeedMnemonic(trimmed)) {
    try {
      return mnemonicToSeedHex(trimmed);
    } catch {
      return null;
    }
  }
  return null;
}
