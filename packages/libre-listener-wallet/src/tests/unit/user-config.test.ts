// @vitest-environment node
// Pins the LDK UserConfig the node starts with. The load-bearing assertion is the inbound-HTLC
// cap: LDK defaults max_inbound_htlc_value_in_flight_percent_of_channel to 10%, which on a small
// (e.g. 25k) channel caps a single INCOMING payment at 2,500 sats — so anything larger fails
// "no route" at the payer (diagnosed live 2026-07-15). We raise it to 100% so the wallet can
// receive up to the full channel capacity. The other assertions guard the extraction of the
// previously-inline config so no existing handshake setting is dropped.
import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { initializeWasmFromBinary } from "lightningdevkit";
import { buildUserConfig } from "../../user-config";

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
    if (fs.existsSync(p)) return fs.readFileSync(p);
  }
  throw new Error("Could not find liblightningjs.wasm");
}

beforeAll(async () => {
  try {
    await initializeWasmFromBinary(loadWasmBinary());
  } catch {
    // already initialized
  }
});

describe("buildUserConfig", () => {
  it("accepts inbound HTLCs up to the full channel capacity (100%), not LDK's 10% default", () => {
    const cfg = buildUserConfig({ minimumDepth: 3, announceChannels: false });
    expect(
      cfg.get_channel_handshake_config().get_max_inbound_htlc_value_in_flight_percent_of_channel()
    ).toBe(100);
  });

  it("preserves the other handshake settings (minimum_depth, announce, manual accept)", () => {
    // LDK's WASM bindings return 1/0 for booleans, so assert truthiness rather than === true.
    const cfg = buildUserConfig({ minimumDepth: 6, announceChannels: true });
    const hs = cfg.get_channel_handshake_config();
    expect(hs.get_minimum_depth()).toBe(6);
    expect(hs.get_announce_for_forwarding()).toBeTruthy();
    expect(cfg.get_manually_accept_inbound_channels()).toBeTruthy();

    // ...and honours announceChannels: false
    const priv = buildUserConfig({ minimumDepth: 3, announceChannels: false });
    expect(priv.get_channel_handshake_config().get_announce_for_forwarding()).toBeFalsy();
  });
});
