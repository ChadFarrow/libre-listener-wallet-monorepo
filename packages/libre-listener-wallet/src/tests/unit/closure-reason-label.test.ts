// @vitest-environment node
// Uses the REAL LDK WASM (no mocking of LDK internals — see the no-mocking testing rule).
// Init boilerplate mirrors bolt11-hints-ldk.test.ts / nwc.test.ts.
import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { initializeWasmFromBinary, ClosureReason, Option_boolZ } from "lightningdevkit";
import { closureReasonLabel } from "../../index";

function loadWasmBinary(): Uint8Array {
  const paths = [
    path.resolve(__dirname, "../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(__dirname, "../../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(__dirname, "../../../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "../../node_modules/lightningdevkit/liblightningjs.wasm"),
  ];
  for (const p of paths) if (fs.existsSync(p)) return fs.readFileSync(p);
  throw new Error("Could not find liblightningjs.wasm");
}

beforeAll(async () => {
  await initializeWasmFromBinary(loadWasmBinary());
});

describe("closureReasonLabel", () => {
  it("maps LDK ClosureReason variants to stable labels", () => {
    expect(closureReasonLabel(ClosureReason.constructor_holder_force_closed(Option_boolZ.constructor_none()))).toBe(
      "we-force-closed",
    );
    expect(closureReasonLabel(ClosureReason.constructor_locally_initiated_cooperative_closure())).toBe("cooperative");
    expect(closureReasonLabel(ClosureReason.constructor_counterparty_initiated_cooperative_closure())).toBe("cooperative");
    expect(closureReasonLabel(ClosureReason.constructor_legacy_cooperative_closure())).toBe("cooperative");
    expect(closureReasonLabel(ClosureReason.constructor_commitment_tx_confirmed())).toBe("force-closed");
    expect(closureReasonLabel(ClosureReason.constructor_outdated_channel_manager())).toBe("outdated-manager");
    expect(closureReasonLabel(ClosureReason.constructor_disconnected_peer())).toBe("other");
    expect(closureReasonLabel(undefined)).toBe("other");
  });
});
