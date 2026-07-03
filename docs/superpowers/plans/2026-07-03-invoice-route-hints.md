# Explicit Invoice Route Hints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every SDK invoice carries a last-hop route hint whenever a usable hintable channel exists — including PUBLIC channels, which LDK's own builder refuses to hint — so external payers (Strike/Zeus/Primal, all proven failing live) can pay a browser leaf node.

**Architecture:** Per the approved spec (`docs/superpowers/specs/2026-07-03-invoice-route-hints-design.md`): LDK builds the invoice exactly as today (payment hash/secret registration, features, CLTV all untouched); a new pure module `bolt11-hints.ts` then appends an `r` tag built from the channel's real forwarding info and re-signs with the node key. BOLT11 tagged fields are self-delimiting 5-bit word runs, so every existing field is carried VERBATIM — the only new bytes are the appended tag and the recomputed signature.

**Tech Stack:** `@noble/curves` (recoverable secp256k1), `@noble/hashes` (sha256), `@scure/base` (bech32) — all pure-JS, audited, already transitive via nostr-tools, promoted to direct SDK deps. npm `bolt11` as DEV-ONLY test oracle. Vitest per repo rules (real LDK WASM where LDK is involved; never mocked).

## Global Constraints

- Package: `packages/libre-listener-wallet`. Kebab-case files; barrel exports via `index.ts`.
- **No LDK mocking** (testing-strategy.md). Pure-function tests use plain objects; LDK cross-validation uses the real WASM via the existing unit-test setup.
- **No silent catches:** transformer failures log via the injected `Logger` and fall back to the ORIGINAL unhinted invoice (never throw out of `buildInvoice` for a hint problem).
- Key isolation: `get_node_secret_key()` is passed into the pure transformer and stored nowhere.
- The transformer MUST refuse to re-sign an invoice whose recovered payee ≠ the public key of the provided secret (cannot mint invoices for another node).
- Runtime deps allowed: `@noble/curves`, `@noble/hashes`, `@scure/base` ONLY (no `bolt11`, `bn.js`, native modules). `bolt11` goes in devDependencies.
- Verification commands (repo root): `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/<file>`, `pnpm --filter @libre/listener-wallet test` runs docker-dependent integration too — use `exec vitest run src/tests/unit` for the full unit suite, plus `pnpm --filter @libre/listener-wallet build`, `pnpm check:storage`.
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## BOLT11 facts the implementer needs (from the spec, BOLT #11)

- Invoice = `bech32(hrp, data)` where `data = timestamp(7 words) ++ tagged-fields ++ signature(104 words)`. Words are 5-bit, MSB-first. Bech32's 90-char limit is LIFTED for invoices (pass a large/disabled limit to encode/decode).
- Tagged field = `[type: 1 word][data_length: 2 words (dl[0]*32 + dl[1])][data: data_length words]`.
- `r` (routing) tag type value = **3**. Payload per hop (concatenated per path; we emit one single-hop path per hint, each as its OWN `r` tag): `pubkey(33) ‖ short_channel_id(8, BE) ‖ fee_base_msat(u32 BE) ‖ fee_proportional_millionths(u32 BE) ‖ cltv_expiry_delta(u16 BE)` = 51 bytes → 8-bit→5-bit words, zero-padded.
- Signature = recoverable ECDSA over `sha256( utf8(hrp) ‖ bytesFromWords(data-without-signature) )` where `bytesFromWords` packs 5-bit words MSB-first, zero-padded to a byte boundary. Signature encodes as `r(32) ‖ s(32) ‖ recovery_id(1)` = 65 bytes = exactly 104 words (no padding).
- LDK invoices have no `n` tag: the payee is RECOVERED from the signature, so re-signing with the same node key preserves the payee.
- `@noble/curves` v2 API differs from v1 — consult the installed `node_modules/@noble/curves` README. Required contract: sign the 32-byte hash directly (no extra hashing), obtain 64-byte compact signature + recovery bit, and recover the public key for the payee check. The npm `bolt11` decoder in tests is the oracle that catches any API misuse (it independently verifies the signature and recovers the payee).

---

### Task 1: `bolt11-hints.ts` — pure transformer + oracle tests

**Files:**
- Create: `packages/libre-listener-wallet/src/bolt11-hints.ts`
- Test: `packages/libre-listener-wallet/src/tests/unit/bolt11-hints.test.ts`
- Modify: `packages/libre-listener-wallet/package.json` (deps)

**Interfaces:**
- Consumes: nothing from the codebase (pure module).
- Produces (used by Tasks 2–3):
  - `interface HintHop { srcNodeId: string; scid: bigint; feeBaseMsat: number; feeProportionalMillionths: number; cltvExpiryDelta: number }`
  - `hasRouteHint(invoice: string): boolean`
  - `appendRouteHints(invoice: string, hints: HintHop[], nodeSecretKey: Uint8Array): string` (throws on malformed invoice / empty hints / payee mismatch)

- [ ] **Step 1: Add dependencies**

In `packages/libre-listener-wallet/package.json` add to `dependencies` (versions matching the workspace store):

```json
"@noble/curves": "^2.0.1",
"@noble/hashes": "^2.0.1",
"@scure/base": "^2.0.0"
```

and to `devDependencies`:

```json
"bolt11": "^1.4.1"
```

Run `pnpm install` at the repo root. If the installed `@noble/hashes` major in the store differs, match the store version (check `ls node_modules/.pnpm | grep noble+hashes`).

- [ ] **Step 2: Write the failing test**

```ts
// packages/libre-listener-wallet/src/tests/unit/bolt11-hints.test.ts
import { describe, it, expect } from "vitest";
// @ts-expect-error dev-only oracle, no bundled types needed
import bolt11 from "bolt11";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hasRouteHint, appendRouteHints, type HintHop } from "../../bolt11-hints";

// Fixed test identity (NOT a real wallet key).
const NODE_SECRET = new Uint8Array(32).fill(7);
const NODE_PUBKEY = Buffer.from(secp256k1.getPublicKey(NODE_SECRET, true)).toString("hex");

const HINT: HintHop = {
  srcNodeId: "028ea4e01d6f7e6d80d2d6902eda9304c4bcda78a6abfda3dee2de94ef46a302d5",
  scid: 1051289246860509185n,
  feeBaseMsat: 1000,
  feeProportionalMillionths: 1,
  cltvExpiryDelta: 80,
};

// Build a realistic LDK-shaped base invoice (payment_hash + secret + features, no hints)
// signed by our test key, using the npm bolt11 oracle.
function baseInvoice(): string {
  const encoded = bolt11.encode({
    network: { bech32: "bc", pubKeyHash: 0, scriptHash: 5, validWitnessVersions: [0] },
    millisatoshis: "1000000",
    timestamp: 1783000000,
    tags: [
      { tagName: "payment_hash", data: "fee68f566e42f76f31ff926edc76acb89b826816fc332fea43fa024f968b7b34" },
      { tagName: "payment_secret", data: "8d4c264bc93be219f0a012beb1349c58debe80c3c9896618a98984f3f9b9063a" },
      { tagName: "description", data: "Libre Listener Wallet top-up" },
      { tagName: "expire_time", data: 3600 },
      { tagName: "min_final_cltv_expiry", data: 45 },
      { tagName: "feature_bits", data: { payment_secret: { required: true }, var_onion_optin: { required: true }, basic_mpp: { supported: true } } },
    ],
  });
  return bolt11.sign(encoded, Buffer.from(NODE_SECRET)).paymentRequest;
}

describe("hasRouteHint", () => {
  it("is false for an unhinted invoice and true after transformation", () => {
    const inv = baseInvoice();
    expect(hasRouteHint(inv)).toBe(false);
    const hinted = appendRouteHints(inv, [HINT], NODE_SECRET);
    expect(hasRouteHint(hinted)).toBe(true);
  });

  it("detects hints on a real-world hinted invoice shape (oracle-built)", () => {
    const encoded = bolt11.encode({
      network: { bech32: "bc", pubKeyHash: 0, scriptHash: 5, validWitnessVersions: [0] },
      millisatoshis: "1000",
      timestamp: 1783000000,
      tags: [
        { tagName: "payment_hash", data: "00".repeat(32).slice(0, 64) },
        { tagName: "payment_secret", data: "11".repeat(32).slice(0, 64) },
        { tagName: "description", data: "x" },
        {
          tagName: "routing_info",
          data: [{ pubkey: HINT.srcNodeId, short_channel_id: "0e97400024b30001", fee_base_msat: 1000, fee_proportional_millionths: 1, cltv_expiry_delta: 80 }],
        },
      ],
    });
    const inv = bolt11.sign(encoded, Buffer.from(NODE_SECRET)).paymentRequest;
    expect(hasRouteHint(inv)).toBe(true);
  });
});

describe("appendRouteHints", () => {
  it("adds the hint and preserves every original field (oracle decode)", () => {
    const inv = baseInvoice();
    const before = bolt11.decode(inv);
    const hinted = appendRouteHints(inv, [HINT], NODE_SECRET);
    const after = bolt11.decode(hinted);

    // Signature valid + payee unchanged (oracle recovers the payee from the signature).
    expect(after.payeeNodeKey).toBe(NODE_PUBKEY);
    expect(after.millisatoshis).toBe(before.millisatoshis);
    expect(after.timestamp).toBe(before.timestamp);
    const tag = (d: any, n: string) => d.tags.find((t: any) => t.tagName === n)?.data;
    for (const name of ["payment_hash", "payment_secret", "description", "expire_time", "min_final_cltv_expiry"]) {
      expect(tag(after, name)).toEqual(tag(before, name));
    }

    // The appended hint round-trips exactly.
    const hints = tag(after, "routing_info");
    expect(hints).toHaveLength(1);
    expect(hints[0].pubkey).toBe(HINT.srcNodeId);
    expect(BigInt("0x" + hints[0].short_channel_id)).toBe(HINT.scid);
    expect(hints[0].fee_base_msat).toBe(HINT.feeBaseMsat);
    expect(hints[0].fee_proportional_millionths).toBe(HINT.feeProportionalMillionths);
    expect(hints[0].cltv_expiry_delta).toBe(HINT.cltvExpiryDelta);
  });

  it("emits one r tag per hint", () => {
    const inv = baseInvoice();
    const second: HintHop = { ...HINT, scid: 42n, feeBaseMsat: 0, feeProportionalMillionths: 0, cltvExpiryDelta: 40 };
    const after = bolt11.decode(appendRouteHints(inv, [HINT, second], NODE_SECRET));
    const rTags = after.tags.filter((t: any) => t.tagName === "routing_info");
    expect(rTags).toHaveLength(2);
  });

  it("refuses to re-sign an invoice issued by a DIFFERENT node (payee mismatch)", () => {
    const otherSecret = new Uint8Array(32).fill(9);
    const inv = baseInvoice(); // signed by NODE_SECRET
    expect(() => appendRouteHints(inv, [HINT], otherSecret)).toThrow(/payee/i);
  });

  it("rejects garbage input and empty hints", () => {
    expect(() => appendRouteHints("lnbc1notaninvoice", [HINT], NODE_SECRET)).toThrow();
    expect(() => appendRouteHints(baseInvoice(), [], NODE_SECRET)).toThrow(/hint/i);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/bolt11-hints.test.ts`
Expected: FAIL — cannot resolve `../../bolt11-hints`.

- [ ] **Step 4: Implement `src/bolt11-hints.ts`**

```ts
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
  const sig = secp256k1.sign(hash, nodeSecretKey, { prehash: false });
  const sigBytes = new Uint8Array(65);
  sigBytes.set(sig.toBytes("compact"), 0);
  sigBytes[64] = sig.recovery;

  // Round-trip safety: the fresh signature must recover to us.
  const newSigWords = bytesToWordsPadded(sigBytes); // 65 bytes → exactly 104 words
  if (recoverPayee(hash, newSigWords) !== ourPubkey) {
    throw new Error("Re-signed invoice failed payee recovery self-check");
  }

  return bech32.encode(hrp, [...newData, ...newSigWords], LIMIT);
}
```

**NOTE on `@noble/curves` v2 API:** the calls above (`secp256k1.sign(hash, key, { prehash: false })`, `sig.toBytes("compact")`, `sig.recovery`, `Signature.fromBytes(..., "compact")`, `.addRecoveryBit(...)`, `.recoverPublicKey(hash).toBytes(true)`) are the v2 shapes as best known — if any name differs in the installed 2.0.1, consult `node_modules/@noble/curves/README.md` and adapt the CALL SITES ONLY (the algorithm is fixed). The oracle test is authoritative: if `bolt11.decode` reports a valid signature and the right payee, the calls are correct. Same for `@scure/base` bech32 (`decode(str, limit)` / `encode(prefix, words, limit)`) and the `@noble/hashes` sha256 import path (`sha2.js` vs `sha256.js`).

- [ ] **Step 5: Run tests until green**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/bolt11-hints.test.ts`
Expected: PASS (all cases). Iterate on noble/scure call-site shapes if the oracle reports bad signatures — do not weaken the assertions.

- [ ] **Step 6: Export from the barrel**

In `packages/libre-listener-wallet/src/index.ts`, add to the exports (near the other utility exports):

```ts
export { hasRouteHint, appendRouteHints, type HintHop } from "./bolt11-hints";
```

- [ ] **Step 7: Full unit suite + build + commit**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit && pnpm --filter @libre/listener-wallet build`
Expected: PASS / build clean.

```bash
git add packages/libre-listener-wallet/src/bolt11-hints.ts packages/libre-listener-wallet/src/tests/unit/bolt11-hints.test.ts packages/libre-listener-wallet/src/index.ts packages/libre-listener-wallet/package.json pnpm-lock.yaml
git commit -m "feat(sdk): pure BOLT11 route-hint transformer (append r tag + re-sign, payee-locked)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: LDK cross-validation of the transformed invoice (real WASM)

**Files:**
- Test: `packages/libre-listener-wallet/src/tests/unit/bolt11-hints-ldk.test.ts`

**Interfaces:**
- Consumes: Task 1's `appendRouteHints`, `HintHop`.
- Produces: proof that LDK itself accepts our transformed invoice (parse + signature check + hints visible). No production code.

- [ ] **Step 1: Find the existing WASM-init pattern**

Look at an existing real-LDK unit test (e.g. `src/tests/unit/peer-disconnect-reentrancy.test.ts` or the event-dispatch test) for how the suite initializes the LDK WASM binary in vitest (an `initializeWasm...` helper / setup import). Reuse that exact pattern — do NOT invent a new init path.

- [ ] **Step 2: Write the test**

```ts
// packages/libre-listener-wallet/src/tests/unit/bolt11-hints-ldk.test.ts
// Cross-validate the hint transformer against LDK's OWN invoice parser: if rust-lightning
// parses the transformed invoice, verifies its signature, and reports the route hint, then
// any real Lightning implementation will. (The npm bolt11 oracle in bolt11-hints.test.ts is
// an independent second opinion; this is the authoritative one.)
import { describe, it, expect, beforeAll } from "vitest";
// @ts-expect-error dev-only oracle
import bolt11 from "bolt11";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { appendRouteHints, type HintHop } from "../../bolt11-hints";
// LDK imports + WASM init: mirror the existing real-LDK unit tests' setup exactly.
import { Bolt11Invoice } from "lightningdevkit";

const NODE_SECRET = new Uint8Array(32).fill(7);

const HINT: HintHop = {
  srcNodeId: "028ea4e01d6f7e6d80d2d6902eda9304c4bcda78a6abfda3dee2de94ef46a302d5",
  scid: 1051289246860509185n,
  feeBaseMsat: 1000,
  feeProportionalMillionths: 1,
  cltvExpiryDelta: 80,
};

function baseInvoice(): string {
  const encoded = bolt11.encode({
    network: { bech32: "bc", pubKeyHash: 0, scriptHash: 5, validWitnessVersions: [0] },
    millisatoshis: "1000000",
    timestamp: 1783000000,
    tags: [
      { tagName: "payment_hash", data: "fee68f566e42f76f31ff926edc76acb89b826816fc332fea43fa024f968b7b34" },
      { tagName: "payment_secret", data: "8d4c264bc93be219f0a012beb1349c58debe80c3c9896618a98984f3f9b9063a" },
      { tagName: "description", data: "Libre Listener Wallet top-up" },
      { tagName: "min_final_cltv_expiry", data: 45 },
      { tagName: "feature_bits", data: { payment_secret: { required: true }, var_onion_optin: { required: true }, basic_mpp: { supported: true } } },
    ],
  });
  return bolt11.sign(encoded, Buffer.from(NODE_SECRET)).paymentRequest;
}

beforeAll(async () => {
  // WASM init exactly as the existing real-LDK unit tests do it.
});

describe("LDK parses our transformed invoice", () => {
  it("valid signature, payee preserved, hint visible to rust-lightning", () => {
    const hinted = appendRouteHints(baseInvoice(), [HINT], NODE_SECRET);
    const parsed = Bolt11Invoice.constructor_from_str(hinted);
    expect(parsed.is_ok()).toBe(true);
    const inv = (parsed as any).res;
    // Signature verification happens inside from_str for signed invoice parsing; assert the
    // recovered payee and the hint survive LDK's strict reading.
    const payee = Buffer.from(inv.recover_payee_pub_key()).toString("hex");
    expect(payee).toBe(Buffer.from(secp256k1.getPublicKey(NODE_SECRET, true)).toString("hex"));
    const routes = inv.route_hints();
    expect(routes.length).toBe(1);
    const hop = routes[0].get_a()[0];
    expect(Buffer.from(hop.get_src_node_id()).toString("hex")).toBe(HINT.srcNodeId);
    expect(hop.get_short_channel_id()).toBe(HINT.scid);
    expect(hop.get_cltv_expiry_delta()).toBe(HINT.cltvExpiryDelta);
    const fees = hop.get_fees();
    expect(fees.get_base_msat()).toBe(HINT.feeBaseMsat);
    expect(fees.get_proportional_millionths()).toBe(HINT.feeProportionalMillionths);
  });
});
```

Adapt the LDK accessor spellings (`route_hints()`, `RouteHint.get_a()`, `recover_payee_pub_key()`, Result unwrapping) to the installed bindings — check `node_modules/lightningdevkit/structs/Bolt11Invoice.d.mts` for exact names. The assertions' MEANING is fixed: parse ok, payee = our key, one hint with our exact hop values.

- [ ] **Step 3: Run to failure, then to green**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/bolt11-hints-ldk.test.ts`
First run may fail on binding-name spelling — fix spellings (not assertions) until PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/libre-listener-wallet/src/tests/unit/bolt11-hints-ldk.test.ts
git commit -m "test(sdk): rust-lightning cross-validates transformed hinted invoices

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `selectHintChannels` — pure hint selection

**Files:**
- Create: `packages/libre-listener-wallet/src/hint-selection.ts`
- Test: `packages/libre-listener-wallet/src/tests/unit/hint-selection.test.ts`

**Interfaces:**
- Consumes: Task 1's `HintHop` type.
- Produces (used by Task 4):
  - `interface HintableChannel { isUsable: boolean; counterpartyNodeId: string; inboundPaymentScid?: bigint; shortChannelId?: bigint; inboundCapacityMsat: bigint; forwardingInfo?: { feeBaseMsat: number; feeProportionalMillionths: number; cltvExpiryDelta: number } }`
  - `selectHintChannels(channels: HintableChannel[]): HintHop[]` (max 3, largest inbound capacity first)

- [ ] **Step 1: Write the failing test**

```ts
// packages/libre-listener-wallet/src/tests/unit/hint-selection.test.ts
import { describe, it, expect } from "vitest";
import { selectHintChannels, type HintableChannel } from "../../hint-selection";

const FWD = { feeBaseMsat: 1000, feeProportionalMillionths: 1, cltvExpiryDelta: 80 };
const base: HintableChannel = {
  isUsable: true,
  counterpartyNodeId: "02" + "ab".repeat(32),
  inboundPaymentScid: 111n,
  shortChannelId: 222n,
  inboundCapacityMsat: 90_000_000n,
  forwardingInfo: FWD,
};

describe("selectHintChannels", () => {
  it("maps a usable channel to a hint via the counterparty's real policy, preferring the inbound-payment scid", () => {
    const [hint] = selectHintChannels([base]);
    expect(hint).toEqual({
      srcNodeId: base.counterpartyNodeId,
      scid: 111n,
      feeBaseMsat: 1000,
      feeProportionalMillionths: 1,
      cltvExpiryDelta: 80,
    });
  });

  it("falls back to short_channel_id when no inbound-payment scid exists", () => {
    const [hint] = selectHintChannels([{ ...base, inboundPaymentScid: undefined }]);
    expect(hint.scid).toBe(222n);
  });

  it("drops channels that are unusable, hintless-scid, or missing forwarding info", () => {
    expect(selectHintChannels([{ ...base, isUsable: false }])).toEqual([]);
    expect(selectHintChannels([{ ...base, inboundPaymentScid: undefined, shortChannelId: undefined }])).toEqual([]);
    expect(selectHintChannels([{ ...base, forwardingInfo: undefined }])).toEqual([]);
  });

  it("sorts by inbound capacity desc and caps at 3", () => {
    const mk = (cap: bigint, scid: bigint): HintableChannel => ({ ...base, inboundCapacityMsat: cap, inboundPaymentScid: scid });
    const hints = selectHintChannels([mk(1n, 1n), mk(4n, 4n), mk(3n, 3n), mk(2n, 2n)]);
    expect(hints.map((h) => h.scid)).toEqual([4n, 3n, 2n]);
  });
});
```

- [ ] **Step 2: Run to failure**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/hint-selection.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// packages/libre-listener-wallet/src/hint-selection.ts
// Chooses which channels to advertise as invoice route hints. Pure and LDK-free: the wallet
// maps real ChannelDetails into HintableChannel (see index.ts) so this stays unit-testable.
import type { HintHop } from "./bolt11-hints";

export interface HintableChannel {
  isUsable: boolean;
  counterpartyNodeId: string;
  inboundPaymentScid?: bigint; // LDK's preferred scid for inbound routing (alias-aware)
  shortChannelId?: bigint;
  inboundCapacityMsat: bigint;
  // The counterparty's forwarding policy from its channel_update. Unknowable until the peer's
  // first update arrives; a channel without it cannot be hinted (payers need fee/cltv).
  forwardingInfo?: { feeBaseMsat: number; feeProportionalMillionths: number; cltvExpiryDelta: number };
}

const MAX_HINTS = 3;

export function selectHintChannels(channels: HintableChannel[]): HintHop[] {
  return channels
    .filter((c) => c.isUsable && c.forwardingInfo && (c.inboundPaymentScid ?? c.shortChannelId) !== undefined)
    .sort((a, b) => (b.inboundCapacityMsat > a.inboundCapacityMsat ? 1 : b.inboundCapacityMsat < a.inboundCapacityMsat ? -1 : 0))
    .slice(0, MAX_HINTS)
    .map((c) => ({
      srcNodeId: c.counterpartyNodeId,
      scid: (c.inboundPaymentScid ?? c.shortChannelId)!,
      feeBaseMsat: c.forwardingInfo!.feeBaseMsat,
      feeProportionalMillionths: c.forwardingInfo!.feeProportionalMillionths,
      cltvExpiryDelta: c.forwardingInfo!.cltvExpiryDelta,
    }));
}
```

- [ ] **Step 4: Run to green, commit**

Run: `pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/hint-selection.test.ts`
Expected: PASS.

```bash
git add packages/libre-listener-wallet/src/hint-selection.ts packages/libre-listener-wallet/src/tests/unit/hint-selection.test.ts
git commit -m "feat(sdk): pure hint-channel selection (usable + forwarding-info, capacity-ranked, max 3)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Wire into `buildInvoice` + no-channel regression + repo verification

**Files:**
- Modify: `packages/libre-listener-wallet/src/index.ts` (buildInvoice + a private mapper)
- Modify: `/Users/chad-mini/Vibe/libre-listener-wallet-monorepo/CLAUDE.md` (SDK bullet, one clause)

**Interfaces:**
- Consumes: Tasks 1+3 (`hasRouteHint`, `appendRouteHints`, `selectHintChannels`, `HintableChannel`).
- Produces: every `createInvoice`/`requestLSPS2Invoice`/NWC `make_invoice` output is hinted when possible.

- [ ] **Step 1: Add the ChannelDetails mapper and wire buildInvoice**

In `packages/libre-listener-wallet/src/index.ts`, import the two modules:

```ts
import { hasRouteHint, appendRouteHints } from "./bolt11-hints";
import { selectHintChannels, type HintableChannel } from "./hint-selection";
```

Add a private method near `buildInvoice`:

```ts
  // Snapshot list_channels() into the pure HintableChannel shape (see hint-selection.ts).
  private hintableChannels(): HintableChannel[] {
    if (!this.channelManager) return [];
    return this.channelManager.list_channels().map((ch: any) => {
      const scidOpt = ch.get_inbound_payment_scid();
      const shortOpt = ch.get_short_channel_id();
      const fwd = ch.get_counterparty().get_forwarding_info();
      return {
        isUsable: ch.get_is_usable(),
        counterpartyNodeId: bytesToHex(ch.get_counterparty().get_node_id()),
        inboundPaymentScid: scidOpt instanceof Option_u64Z_Some ? scidOpt.some : undefined,
        shortChannelId: shortOpt instanceof Option_u64Z_Some ? shortOpt.some : undefined,
        inboundCapacityMsat: ch.get_inbound_capacity_msat(),
        forwardingInfo: fwd
          ? {
              feeBaseMsat: fwd.get_fee_base_msat(),
              feeProportionalMillionths: fwd.get_fee_proportional_millionths(),
              cltvExpiryDelta: fwd.get_cltv_expiry_delta(),
            }
          : undefined,
      };
    });
  }
```

(Match the existing file's Option-unwrapping idiom — search `index.ts` for how it already
unwraps `Option_u64Z` (e.g. in `mapChannelDetails`) and use the same spelling; import
`Option_u64Z_Some` only if the file doesn't already.)

At the END of `buildInvoice` (after `const invoice = ...to_str();`, before the preimage
persist/return), insert:

```ts
    // LDK refuses route hints when ANY public channel exists, which strands an unannounced
    // leaf node (nothing can route to it from gossip alone — proven live: external payers all
    // "no route"). Ensure a last-hop hint: append + re-sign via the pure transformer. Hints on
    // public channels are legal BOLT11. Best-effort: a transformer failure logs and falls back
    // to the original (a direct peer can still pay it) — never fail invoice creation over it.
    let finalInvoice = invoice;
    try {
      if (!hasRouteHint(invoice)) {
        const hints = selectHintChannels(this.hintableChannels());
        if (hints.length && this.keysManager) {
          finalInvoice = appendRouteHints(invoice, hints, this.keysManager.get_node_secret_key());
          this.logger?.info(`[Invoice] Appended ${hints.length} route hint(s) (LDK omitted hints)`);
        }
      }
    } catch (e) {
      this.logger?.warn?.(`[Invoice] Route-hint append failed; returning unhinted invoice: ${(e as Error)?.message ?? e}`);
      finalInvoice = invoice;
    }
```

and make the method return/persist using `finalInvoice` in place of `invoice` (the preimage
persist line is keyed by payment hash and is unaffected). Check the Logger interface for the
warn method name (`warn` exists per the conventions); adjust the optional-chain accordingly.

- [ ] **Step 2: No-channel regression (extend an existing real-LDK unit test)**

Find the existing unit test that starts a real wallet and creates an invoice (search
`src/tests/unit` for `createInvoice`). Add/extend a case asserting the no-channel path is
untouched:

```ts
it("invoice from a channel-less wallet has no route hints and remains LDK-original", async () => {
  const invoice = await wallet.createInvoice(1000, "test", 3600);
  expect(hasRouteHint(invoice)).toBe(false); // no channels → nothing to hint, invoice untouched
});
```

If no such test exists, create `src/tests/unit/invoice-hints-wiring.test.ts` following the
same wallet-boot pattern as the other real-LDK unit tests (jsdom + MSW esplora mock at tip 0,
per the peer-disconnect test).

- [ ] **Step 3: Full verification**

Run:
`pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit && pnpm --filter @libre/listener-wallet build && pnpm check:storage && pnpm --filter @libre/browser-extension test && pnpm --filter @libre/browser-extension build && pnpm --filter @libre/nwc-push-gateway test`
Expected: ALL PASS (the extension bundles the SDK, so its build re-verifies bundling; storage contracts untouched).

- [ ] **Step 4: CLAUDE.md**

In the repo-root CLAUDE.md SDK bullet, find `createInvoice()` (one shared private `buildInvoice()` behind it` and extend that parenthetical: after `and NWC make_invoice` insert `; buildInvoice force-appends a last-hop route hint via bolt11-hints.ts/hint-selection.ts when LDK omits hints (LDK hints nothing when ANY public channel exists, stranding an unannounced leaf node — external pathfinders refuse to route to it; the transformer re-signs with the node key and is payee-locked)`.

- [ ] **Step 5: Commit**

```bash
git add packages/libre-listener-wallet/src/index.ts packages/libre-listener-wallet/src/tests/unit CLAUDE.md
git commit -m "feat(sdk): invoices always carry a last-hop route hint (public channels included)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review (done at plan-writing time)

- **Spec coverage:** transformer (T1), LDK cross-validation (T2), selection (T3), wiring + fallback + docs (T4). Live mainnet proof is the user's step after deploy (controller handles the extension rebuild/deploy outside this plan).
- **Placeholder scan:** the two "adapt spellings to installed bindings/noble API" notes are deliberate — exact library call shapes are verified against installed packages at implement time, with the npm-bolt11 oracle + LDK parser as authoritative correctness gates; assertions are fully specified.
- **Type consistency:** `HintHop` (T1) consumed by T3's return and T2's test; `HintableChannel` (T3) produced by T4's mapper; `hasRouteHint`/`appendRouteHints` signatures match at all call sites.
