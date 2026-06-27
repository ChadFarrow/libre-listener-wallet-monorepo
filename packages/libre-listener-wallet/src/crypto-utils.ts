/** Cryptographically-secure random bytes (preimages, payment ids, etc.). */
export function getSecureRandomBytes(len: number): Uint8Array {
  const bytes = new Uint8Array(len);
  if (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    throw new Error("Secure random bytes generation not supported in this environment");
  }
  return bytes;
}
