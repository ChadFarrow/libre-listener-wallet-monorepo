// @vitest-environment node
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
