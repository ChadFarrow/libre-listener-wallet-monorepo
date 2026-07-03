// @vitest-environment node
// Cross-validate the hint transformer against LDK's OWN invoice parser: if rust-lightning
// parses the transformed invoice, verifies its signature, and reports the route hint, then
// any real Lightning implementation will. (The npm bolt11 oracle in bolt11-hints.test.ts is
// an independent second opinion; this is the authoritative one.)
import { describe, it, expect, beforeAll } from "vitest";
// @ts-expect-error dev-only oracle, no bundled types needed
import bolt11 from "bolt11";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { appendRouteHints, type HintHop } from "../../bolt11-hints";
import { Bolt11Invoice, initializeWasmFromBinary } from "lightningdevkit";
import * as fs from "fs";
import * as path from "path";

// Mirrors the WASM-init pattern used by nwc.test.ts / peer-disconnect-reentrancy.test.ts —
// reuse it exactly rather than inventing a new one.
function loadWasmBinary(): Uint8Array {
  const paths = [
    path.resolve(__dirname, "../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(__dirname, "../../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(__dirname, "../../../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(__dirname, "../../../../../node_modules/.pnpm/node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "../../node_modules/lightningdevkit/liblightningjs.wasm"),
  ];

  for (const p of paths) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p);
    }
  }
  throw new Error("Could not find liblightningjs.wasm");
}

beforeAll(async () => {
  try {
    await initializeWasmFromBinary(loadWasmBinary());
  } catch (e) {
    // ignore if already initialized
  }
});

const NODE_SECRET = new Uint8Array(32).fill(7);

const HINT: HintHop = {
  srcNodeId: "028ea4e01d6f7e6d80d2d6902eda9304c4bcda78a6abfda3dee2de94ef46a302d5",
  scid: 1051289246860509185n,
  feeBaseMsat: 1000,
  feeProportionalMillionths: 1,
  cltvExpiryDelta: 80,
};

// Crib the base-invoice construction from bolt11-hints.test.ts's oracle helper.
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

describe("LDK parses our transformed invoice", () => {
  it("valid signature, payee preserved, hint visible to rust-lightning", () => {
    const hinted = appendRouteHints(baseInvoice(), [HINT], NODE_SECRET);
    const parsed = Bolt11Invoice.constructor_from_str(hinted);
    expect(parsed.is_ok()).toBeTruthy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inv = (parsed as any).res as Bolt11Invoice;

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
