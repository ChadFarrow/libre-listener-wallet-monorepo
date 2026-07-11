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
  // Hex path: strip ALL internal whitespace first. The seed is shown on screen grouped in
  // space-separated blocks (e.g. "8f3a1c9e 5b2d7f0a …"); a user who highlights that display instead
  // of using the Copy button (which copies the raw hex) would otherwise paste a spaced value that
  // fails to restore — a scary "my seed doesn't work" trap even though the seed is correct. A
  // whitespace-stripped 24-word phrase can't be 64 hex chars, so this never mis-catches a mnemonic.
  const dehex = trimmed.replace(/\s+/g, "");
  if (SEED_HEX_RE.test(dehex)) return dehex.toLowerCase();
  // Phrase path: normalize any newlines/double spaces between words to single spaces before checking.
  const phrase = trimmed.replace(/\s+/g, " ");
  if (isValidSeedMnemonic(phrase)) {
    try {
      return mnemonicToSeedHex(phrase);
    } catch {
      return null;
    }
  }
  return null;
}
