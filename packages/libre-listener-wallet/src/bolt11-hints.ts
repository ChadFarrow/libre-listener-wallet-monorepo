// Pure BOLT11 route-hint transformer. LDK's invoice builder refuses hints when ANY public
// channel exists ("Not including channels in invoice route hints on account of public
// channel"), which leaves a browser leaf node unpayable by external pathfinders (proven live:
// Strike/Zeus/Primal all "no route" while a direct-peer payment settles). This module takes
// the LDK-built invoice — whose payment hash/secret/features/CLTV are already registered and
// proven — appends an `r` tag with the channel's real forwarding policy, and re-signs with the
// node key. Tagged fields are self-delimiting 5-bit word runs, so every original field is
// carried verbatim; the ONLY new bytes are the appended tag(s) and the recomputed signature.
//
// Key isolation: the node secret is a parameter, used once for signing, stored nowhere.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32 } from "@scure/base";

export interface HintHop {
  srcNodeId: string; // 33-byte compressed pubkey hex of the node the payer routes THROUGH
  scid: bigint; // short channel id of the hop into us
  feeBaseMsat: number;
  feeProportionalMillionths: number;
  cltvExpiryDelta: number;
}

const SIG_WORDS = 104; // 65 signature bytes (r‖s‖recovery) * 8 / 5
const TIMESTAMP_WORDS = 7;
const ROUTING_TAG_TYPE = 3; // 'r'
// Bech32's 90-char cap does not apply to BOLT11 invoices.
const LIMIT = 10_000;

function wordsToBytesPadded(words: number[]): Uint8Array {
  // Pack 5-bit words MSB-first, zero-padding the final byte (BOLT11 signing rule).
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const w of words) {
    acc = (acc << 5) | (w & 31);
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (bits > 0) out.push((acc << (8 - bits)) & 0xff);
  return new Uint8Array(out);
}

function bytesToWordsPadded(bytes: Uint8Array): number[] {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >> bits) & 31);
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

function hexToBytesStrict(hex: string, expectLen: number, what: string): Uint8Array {
  if (!new RegExp(`^[0-9a-fA-F]{${expectLen * 2}}$`).test(hex)) {
    throw new Error(`Invalid ${what}: expected ${expectLen} hex bytes`);
  }
  const out = new Uint8Array(expectLen);
  for (let i = 0; i < expectLen; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function writeUIntBE(target: Uint8Array, value: bigint, offset: number, byteLen: number): void {
  for (let i = byteLen - 1; i >= 0; i--) {
    target[offset + i] = Number(value & 0xffn);
    value >>= 8n;
  }
}

interface ParsedInvoice {
  hrp: string;
  dataWords: number[]; // timestamp + tagged fields (signature excluded)
  sigWords: number[];
}

function parseInvoice(invoice: string): ParsedInvoice {
  const decoded = bech32.decode(invoice.toLowerCase() as `${string}1${string}`, LIMIT);
  const words = Array.from(decoded.words);
  if (words.length <= TIMESTAMP_WORDS + SIG_WORDS) throw new Error("Invoice too short to contain tagged fields");
  return {
    hrp: decoded.prefix,
    dataWords: words.slice(0, words.length - SIG_WORDS),
    sigWords: words.slice(words.length - SIG_WORDS),
  };
}

// Walk the self-delimiting tagged fields looking for a routing (`r`) tag.
export function hasRouteHint(invoice: string): boolean {
  const { dataWords } = parseInvoice(invoice);
  let i = TIMESTAMP_WORDS;
  while (i + 3 <= dataWords.length) {
    const type = dataWords[i];
    const len = dataWords[i + 1] * 32 + dataWords[i + 2];
    if (type === ROUTING_TAG_TYPE) return true;
    i += 3 + len;
  }
  return false;
}

function encodeRoutingTag(hint: HintHop): number[] {
  const payload = new Uint8Array(51);
  payload.set(hexToBytesStrict(hint.srcNodeId.toLowerCase(), 33, "hint srcNodeId"), 0);
  writeUIntBE(payload, hint.scid, 33, 8);
  writeUIntBE(payload, BigInt(hint.feeBaseMsat), 41, 4);
  writeUIntBE(payload, BigInt(hint.feeProportionalMillionths), 45, 4);
  writeUIntBE(payload, BigInt(hint.cltvExpiryDelta), 49, 2);
  const dataWords = bytesToWordsPadded(payload);
  return [ROUTING_TAG_TYPE, Math.floor(dataWords.length / 32), dataWords.length % 32, ...dataWords];
}

function signingHash(hrp: string, dataWords: number[]): Uint8Array {
  const hrpBytes = new TextEncoder().encode(hrp);
  const dataBytes = wordsToBytesPadded(dataWords);
  const msg = new Uint8Array(hrpBytes.length + dataBytes.length);
  msg.set(hrpBytes, 0);
  msg.set(dataBytes, hrpBytes.length);
  return sha256(msg);
}

function recoverPayee(hash: Uint8Array, sigWords: number[]): string {
  // BOLT11 wire order is r(32)‖s(32)‖recoveryId(1) — the LAST byte is the recovery id.
  const sigBytes = wordsToBytesPadded(sigWords).slice(0, 65);
  const sig = secp256k1.Signature.fromBytes(sigBytes.slice(0, 64), "compact").addRecoveryBit(sigBytes[64]);
  return bytesToHex(sig.recoverPublicKey(hash).toBytes(true));
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/**
 * Append route hint(s) to a BOLT11 invoice and re-sign it with the issuing node's secret.
 * Refuses to transform an invoice whose recovered payee is not the key we were given —
 * this function must never be able to mint a valid invoice for someone else's node.
 */
export function appendRouteHints(invoice: string, hints: HintHop[], nodeSecretKey: Uint8Array): string {
  if (!hints.length) throw new Error("appendRouteHints requires at least one hint");
  const { hrp, dataWords, sigWords } = parseInvoice(invoice);

  const ourPubkey = bytesToHex(secp256k1.getPublicKey(nodeSecretKey, true));
  const originalPayee = recoverPayee(signingHash(hrp, dataWords), sigWords);
  if (originalPayee !== ourPubkey) {
    throw new Error("Refusing to re-sign: invoice payee does not match the provided node key");
  }

  const newData = [...dataWords];
  for (const hint of hints) newData.push(...encodeRoutingTag(hint));

  const hash = signingHash(hrp, newData);
  // @noble/curves v2's `format: "recovered"` output is [recoveryId, r(32), s(32)] — the
  // recovery id comes FIRST. BOLT11's wire order is r‖s‖recoveryId (recovery id LAST), so
  // reorder into the on-wire layout before encoding.
  const recSig = secp256k1.sign(hash, nodeSecretKey, { prehash: false, format: "recovered" });
  const sigBytes = new Uint8Array(65);
  sigBytes.set(recSig.slice(1), 0); // r || s
  sigBytes[64] = recSig[0]; // recovery id

  // Round-trip safety: the fresh signature must recover to us.
  const newSigWords = bytesToWordsPadded(sigBytes); // 65 bytes → exactly 104 words
  if (recoverPayee(hash, newSigWords) !== ourPubkey) {
    throw new Error("Re-signed invoice failed payee recovery self-check");
  }

  return bech32.encode(hrp, [...newData, ...newSigWords], LIMIT);
}
