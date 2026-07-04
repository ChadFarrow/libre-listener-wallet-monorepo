// @vitest-environment node
// Drives the REAL LDK CustomMessageHandler (no mocking) — proves our request queues a 37913 message
// with the right bytes, and an incoming response resolves the correct pending promise.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { Type, initializeWasmFromBinary } from "lightningdevkit";
import * as fs from "fs";
import * as path from "path";
import { LspsPeerClient } from "../../lsps-peer-client";
import { encodeLspsMessage, decodeLspsMessage, LSPS_PEER_MSG_TYPE } from "../../lsps-message";

function loadWasmBinary(): Uint8Array {
  const paths = [
    path.resolve(__dirname, "../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "../../node_modules/lightningdevkit/liblightningjs.wasm"),
  ];
  for (const p of paths) if (fs.existsSync(p)) return fs.readFileSync(p);
  throw new Error("Could not find liblightningjs.wasm");
}

beforeAll(async () => {
  try {
    await initializeWasmFromBinary(loadWasmBinary());
  } catch {
    /* already initialized */
  }
});

const PEER = "038a9e56512ec98da2b5789761f7af8f280baf98a09282360cd6ff1381b5e889bf";
const SENDER = new Uint8Array(33).fill(2);

describe("LspsPeerClient", () => {
  it("request queues an outbound 37913 message and resolves on the matching response", async () => {
    const client = new LspsPeerClient();
    const handler = client.buildHandler();
    client.setPeerManager({ process_events: () => {} } as any); // stub: flush is a no-op in the unit

    const p = client.request(PEER, "lsps2.get_versions", {});

    // Our request should now be a pending outbound message.
    const pending = handler.get_and_clear_pending_msg();
    expect(pending.length).toBe(1);
    const t = pending[0].get_b();
    // KNOWN LDK-WASM BINDING QUIRK (lightningdevkit@0.1.0): Type.type_id() reads a JS-constructed
    // Type's type_id back through a wasm accessor (TS_Type_type_id) whose generated C header
    // declares an int16_t return where the value is really a uint16_t. Any type_id with the top bit
    // set (>= 32768 — includes our LSPS custom-message type 37913 = 0x9419) round-trips as its
    // signed 16-bit twin (37913 - 65536 = -27623). Verified directly against the real WASM binary
    // across a range of values; it's purely a JS-side introspection artifact of this one accessor —
    // the actual wire bytes (decoded below via t.write()) are unaffected.
    const rawTypeId = t.type_id();
    const normalizedTypeId = rawTypeId < 0 ? rawTypeId + 65536 : rawTypeId;
    expect(normalizedTypeId).toBe(LSPS_PEER_MSG_TYPE);
    const sentReq = decodeLspsMessage(t.write());
    expect(sentReq).toMatchObject({ jsonrpc: "2.0", method: "lsps2.get_versions", params: {} });
    expect(typeof sentReq.id).toBe("string");

    // Craft the LSP's response with the same id and feed it back through the handler.
    const respBytes = encodeLspsMessage({ jsonrpc: "2.0", id: sentReq.id, result: { versions: [1] } });
    const respType = Type.new_impl({ type_id: () => LSPS_PEER_MSG_TYPE, debug_str: () => "x", write: () => respBytes });
    handler.handle_custom_message(respType, SENDER);

    await expect(p).resolves.toEqual({ versions: [1] });
  });

  it("rejects the promise when the LSP returns a JSON-RPC error", async () => {
    const client = new LspsPeerClient();
    const handler = client.buildHandler();
    client.setPeerManager({ process_events: () => {} } as any);

    const p = client.getInfo(PEER);
    const sentReq = decodeLspsMessage(handler.get_and_clear_pending_msg()[0].get_b().write());
    const respBytes = encodeLspsMessage({ jsonrpc: "2.0", id: sentReq.id, error: { code: 1, message: "unsupported" } });
    handler.handle_custom_message(
      Type.new_impl({ type_id: () => LSPS_PEER_MSG_TYPE, debug_str: () => "x", write: () => respBytes }),
      SENDER
    );
    await expect(p).rejects.toThrow(/unsupported/);
  });

  it("ignores a response with an unknown id (no throw, promise stays pending)", async () => {
    vi.useFakeTimers(); // so the request's pending timer isn't a real leaked handle
    try {
      const client = new LspsPeerClient();
      const handler = client.buildHandler();
      client.setPeerManager({ process_events: () => {} } as any);

      let settled = false;
      const p = client.request(PEER, "lsps2.get_versions", {}, { timeoutMs: 60_000 });
      void p.then(() => (settled = true)).catch(() => (settled = true));
      handler.get_and_clear_pending_msg(); // drain

      const stray = encodeLspsMessage({ jsonrpc: "2.0", id: "not-a-real-id", result: {} });
      expect(() =>
        handler.handle_custom_message(
          Type.new_impl({ type_id: () => LSPS_PEER_MSG_TYPE, debug_str: () => "x", write: () => stray }),
          SENDER
        )
      ).not.toThrow();
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers(); // discards the still-pending fake timer
    }
  });

  it("rejects on timeout", async () => {
    vi.useFakeTimers();
    try {
      const client = new LspsPeerClient();
      client.buildHandler();
      client.setPeerManager({ process_events: () => {} } as any);
      const p = client.request(PEER, "lsps2.get_versions", {}, { timeoutMs: 5000 });
      const rejected = expect(p).rejects.toThrow(/timed out/);
      vi.advanceTimersByTime(5001);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});
