import { describe, it, expect } from "vitest";
import {
  encodeKeyValue,
  decodeKeyValue,
  encodeGetObjectRequest,
  encodePutObjectRequest,
  encodeDeleteObjectRequest,
  encodeListKeyVersionsRequest,
  decodeGetObjectResponse,
  decodeListKeyVersionsResponse,
  decodeErrorResponse,
  VSS_ERROR_CODE,
} from "../../vss-protobuf";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");

describe("vss-protobuf KeyValue", () => {
  it("encodes to the exact proto3 wire bytes (interop with vss-server)", () => {
    // KeyValue { key="foo"(1), version=5(2), value=[de ad](3) }
    // 0a 03 'f''o''o' | 10 05 | 1a 02 de ad
    const bytes = encodeKeyValue({ key: "foo", version: 5, value: Uint8Array.from([0xde, 0xad]) });
    expect(hex(bytes)).toBe("0a 03 66 6f 6f 10 05 1a 02 de ad");
  });

  it("omits a version of 0 and an empty value (proto3 defaults)", () => {
    const bytes = encodeKeyValue({ key: "k", version: 0, value: new Uint8Array(0) });
    expect(hex(bytes)).toBe("0a 01 6b");
  });

  it("encodes a multi-byte varint version (300 -> ac 02)", () => {
    const bytes = encodeKeyValue({ key: "", version: 300, value: new Uint8Array(0) });
    expect(hex(bytes)).toBe("10 ac 02");
  });

  it("encodes the blind-write version -1 as protobuf's 10-byte two's-complement varint", () => {
    // int64 -1 == unsigned 2^64-1 == nine 0xff bytes then 0x01 (what LDK's VssStore sends).
    const bytes = encodeKeyValue({ key: "", version: -1, value: new Uint8Array(0) });
    expect(hex(bytes)).toBe("10 ff ff ff ff ff ff ff ff ff 01");
  });

  it("decodes the -1 sentinel back to -1 (signed int64), not a giant positive", () => {
    const decoded = decodeKeyValue(encodeKeyValue({ key: "k", version: -1, value: new Uint8Array(0) }));
    expect(decoded.version).toBe(-1);
  });

  it("round-trips through decode, including a large version", () => {
    const kv = { key: "channel_manager", version: 9007199254740000, value: Uint8Array.from([1, 2, 3, 255, 0]) };
    const decoded = decodeKeyValue(encodeKeyValue(kv));
    expect(decoded.key).toBe(kv.key);
    expect(decoded.version).toBe(kv.version);
    expect(Array.from(decoded.value)).toEqual(Array.from(kv.value));
  });
});

describe("vss-protobuf requests", () => {
  it("GetObjectRequest carries store_id(1) and key(2)", () => {
    // 0a 02 's''i' | 12 03 'k''e''y'
    expect(hex(encodeGetObjectRequest("si", "key"))).toBe("0a 02 73 69 12 03 6b 65 79");
  });

  it("PutObjectRequest nests transaction items as repeated field 3", () => {
    const bytes = encodePutObjectRequest({
      storeId: "s",
      transactionItems: [
        { key: "a", version: 0, value: Uint8Array.from([9]) },
        { key: "b", version: 2, value: new Uint8Array(0) },
      ],
    });
    // store_id: 0a 01 73
    // item a: 1a <len> (0a 01 'a' 1a 01 09)  -> inner = 0a 01 61 1a 01 09 (6 bytes) -> 1a 06 ...
    // item b: 1a <len> (0a 01 'b' 10 02)     -> inner = 0a 01 62 10 02 (5 bytes)    -> 1a 05 ...
    expect(hex(bytes)).toBe("0a 01 73 1a 06 0a 01 61 1a 01 09 1a 05 0a 01 62 10 02");
  });

  it("PutObjectRequest encodes an explicit globalVersion even when 0 (optional field)", () => {
    const bytes = encodePutObjectRequest({ storeId: "s", globalVersion: 0, transactionItems: [] });
    // 0a 01 73 | 10 00  (global_version present as 0)
    expect(hex(bytes)).toBe("0a 01 73 10 00");
  });

  it("DeleteObjectRequest wraps the key/version in field 2", () => {
    const bytes = encodeDeleteObjectRequest("s", { key: "gone", version: 7, value: new Uint8Array(0) });
    // store_id 0a 01 73 | key_value 12 <len> (0a 04 'gone' 10 07) inner=8 bytes
    expect(hex(bytes)).toBe("0a 01 73 12 08 0a 04 67 6f 6e 65 10 07");
  });

  it("ListKeyVersionsRequest carries store_id and optional prefix/page", () => {
    const bytes = encodeListKeyVersionsRequest({ storeId: "s", keyPrefix: "tx_", pageSize: 100 });
    // 0a 01 73 | 12 03 't''x''_' | 18 64
    expect(hex(bytes)).toBe("0a 01 73 12 03 74 78 5f 18 64");
  });
});

describe("vss-protobuf responses", () => {
  it("decodes GetObjectResponse (value in field 2)", () => {
    // Build a GetObjectResponse by hand: field 2 (message) wrapping a KeyValue.
    const kv = encodeKeyValue({ key: "seed", version: 3, value: Uint8Array.from([0xaa, 0xbb]) });
    const resp = Uint8Array.from([0x12, kv.length, ...kv]);
    const decoded = decodeGetObjectResponse(resp);
    expect(decoded).not.toBeNull();
    expect(decoded!.key).toBe("seed");
    expect(decoded!.version).toBe(3);
    expect(Array.from(decoded!.value)).toEqual([0xaa, 0xbb]);
  });

  it("returns null for a GetObjectResponse with no value", () => {
    expect(decodeGetObjectResponse(new Uint8Array(0))).toBeNull();
  });

  it("decodes ListKeyVersionsResponse with items, next page token, and global version", () => {
    const kvA = encodeKeyValue({ key: "a", version: 1, value: new Uint8Array(0) });
    const kvB = encodeKeyValue({ key: "b", version: 4, value: new Uint8Array(0) });
    const token = new TextEncoder().encode("next");
    const resp = Uint8Array.from([
      0x0a, kvA.length, ...kvA, // key_versions[0]
      0x0a, kvB.length, ...kvB, // key_versions[1]
      0x12, token.length, ...token, // next_page_token
      0x18, 0x2a, // global_version = 42
    ]);
    const out = decodeListKeyVersionsResponse(resp);
    expect(out.keyVersions.map((k) => [k.key, k.version])).toEqual([
      ["a", 1],
      ["b", 4],
    ]);
    expect(out.nextPageToken).toBe("next");
    expect(out.globalVersion).toBe(42);
  });

  it("decodes an ErrorResponse and exposes the conflict code", () => {
    const msg = new TextEncoder().encode("version conflict");
    const resp = Uint8Array.from([0x08, VSS_ERROR_CODE.ConflictException, 0x12, msg.length, ...msg]);
    const err = decodeErrorResponse(resp);
    expect(err.errorCode).toBe(VSS_ERROR_CODE.ConflictException);
    expect(err.message).toBe("version conflict");
  });

  it("tolerates unknown fields when decoding (forward-compat)", () => {
    // A KeyValue with an extra unknown field 15 (varint) appended.
    const base = encodeKeyValue({ key: "x", version: 1, value: new Uint8Array(0) });
    const withUnknown = Uint8Array.from([...base, 0x78, 0x63]); // field 15 varint = 0x63
    const decoded = decodeKeyValue(withUnknown);
    expect(decoded.key).toBe("x");
    expect(decoded.version).toBe(1);
  });
});
