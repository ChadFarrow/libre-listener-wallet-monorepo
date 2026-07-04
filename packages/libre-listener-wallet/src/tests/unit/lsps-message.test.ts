import { describe, it, expect } from "vitest";
import {
  LSPS_PEER_MSG_TYPE,
  encodeLspsMessage,
  decodeLspsMessage,
  buildRequest,
  parseResponse,
  newRequestId,
  hexToBytes,
  isLspsMessageType,
} from "../../lsps-message";

describe("lsps-message wire format", () => {
  it("uses peer message type 37913", () => {
    expect(LSPS_PEER_MSG_TYPE).toBe(37913);
  });

  it("encode/decode round-trips a JSON-RPC object (UTF-8, no prefix)", () => {
    const obj = { jsonrpc: "2.0", id: "a1", method: "lsps2.get_info", params: { version: 1 } };
    const bytes = encodeLspsMessage(obj);
    // exact bytes are the JSON string in UTF-8, nothing prepended
    expect(new TextDecoder().decode(bytes)).toBe(JSON.stringify(obj));
    expect(decodeLspsMessage(bytes)).toEqual(obj);
  });

  it("buildRequest produces a JSON-RPC 2.0 request with a string id", () => {
    expect(buildRequest("lsps2.get_versions", {}, "xyz")).toEqual({
      jsonrpc: "2.0",
      id: "xyz",
      method: "lsps2.get_versions",
      params: {},
    });
  });

  it("parseResponse extracts result, error, and rejects id-less objects", () => {
    expect(parseResponse({ jsonrpc: "2.0", id: "1", result: { versions: [1] } })).toEqual({
      id: "1",
      result: { versions: [1] },
    });
    expect(parseResponse({ jsonrpc: "2.0", id: "2", error: { code: -32000, message: "no" } })).toEqual({
      id: "2",
      error: { code: -32000, message: "no" },
    });
    expect(parseResponse({ jsonrpc: "2.0", method: "notify" })).toBeNull(); // no id
    expect(parseResponse(null)).toBeNull();
  });

  it("newRequestId is unique and 32 hex chars", () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it("hexToBytes parses a pubkey and rejects malformed hex", () => {
    expect(Array.from(hexToBytes("02aa"))).toEqual([0x02, 0xaa]);
    expect(hexToBytes("0x02aa")).toEqual(new Uint8Array([0x02, 0xaa]));
    expect(() => hexToBytes("abc")).toThrow(); // odd length
    expect(() => hexToBytes("zz")).toThrow(); // not hex
  });

  it("isLspsMessageType recognizes 37913 in both its plain and sign-extended int16 forms", () => {
    // lightningdevkit@0.1.0 bindings can hand back a u16 message type >= 32768 as a sign-extended
    // int16 (37913 -> -27623). Masking to 16 bits must recognize both representations.
    expect(isLspsMessageType(37913)).toBe(true);
    expect(isLspsMessageType(-27623)).toBe(true);
    expect(isLspsMessageType(37914)).toBe(false);
    expect(isLspsMessageType(0)).toBe(false);
  });
});
