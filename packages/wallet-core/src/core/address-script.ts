import { bech32, bech32m } from "@scure/base";

// Convert an on-chain Bitcoin address to its scriptPubKey bytes, for sweeping force-closed
// funds to an address the user supplies. Supports segwit: P2WPKH/P2WSH (v0, bech32) and
// P2TR / future witness versions (v1+, bech32m). Legacy base58 (1.../3...) is unsupported —
// throws with a clear message. The checksum variant (bech32 vs bech32m) inherently enforces
// the witness version, so we try both and trust the one that validates.
function decodeSegwit(addr: string): { hrp: string; version: number; program: Uint8Array } | null {
  for (const codec of [bech32, bech32m] as const) {
    try {
      const { prefix, words } = codec.decode(addr as `${string}1${string}`, 90);
      if (words.length < 1) continue;
      const version = words[0];
      const program = codec.fromWords(words.slice(1));
      if (codec === bech32 && version !== 0) continue;   // bech32 only valid for v0
      if (codec === bech32m && version === 0) continue;   // bech32m only valid for v1+
      return { hrp: prefix, version, program };
    } catch {
      /* wrong checksum variant — try the next codec */
    }
  }
  return null;
}

// Segwit human-readable prefix per Bitcoin network. A wrong-chain address (e.g. a
// Litecoin "ltc1…" or a testnet "tb1…" pasted on mainnet) decodes as valid bech32
// but would sweep force-closed funds to a script the user can't spend on the real
// chain — so the HRP must be checked against the active network.
const HRP_BY_NETWORK: Record<string, string> = {
  mainnet: "bc",
  bitcoin: "bc",
  testnet: "tb",
  signet: "tb",
  regtest: "bcrt",
};

export function addressToScriptPubKey(address: string, network?: string): Uint8Array {
  const seg = decodeSegwit(address.trim());
  if (!seg) {
    throw new Error("Unsupported address — use a bech32 segwit address (bc1q… / bc1p…).");
  }
  if (network) {
    const expected = HRP_BY_NETWORK[network];
    if (expected && seg.hrp !== expected) {
      throw new Error(
        `Address is for the wrong network (got "${seg.hrp}", expected "${expected}" for ${network}). Funds would be unspendable.`,
      );
    }
  }
  const { version, program } = seg;
  if (version < 0 || version > 16) throw new Error("Invalid witness version.");
  if (version === 0 && program.length !== 20 && program.length !== 32) {
    throw new Error("Invalid v0 segwit program length.");
  }
  if (program.length < 2 || program.length > 40) throw new Error("Invalid witness program length.");
  // scriptPubKey: OP_<version> PUSH(len) <program>. OP_0 = 0x00; OP_1..OP_16 = 0x50 + version.
  const op = version === 0 ? 0x00 : 0x50 + version;
  return Uint8Array.from([op, program.length, ...program]);
}
