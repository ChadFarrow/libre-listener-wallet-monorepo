// Server-side half of the VSS protobuf codec: decode the requests the CLIENT sends, encode the
// responses it parses. Used ONLY by the in-process test VSS server (vss-test-server.ts) — kept out
// of src/vss-protobuf.ts so the shipped SDK (and the SW bundles built from it) carries only the
// client half. Symmetric with the client functions; all pure.
import {
  Reader,
  Writer,
  WIRE_VARINT,
  WIRE_LEN,
  encodeKeyValue,
  decodeKeyValue,
  type VssKeyValue,
} from "../../vss-protobuf";

export function decodeGetObjectRequest(buf: Uint8Array): { storeId: string; key: string } {
  const r = new Reader(buf);
  const out = { storeId: "", key: "" };
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === WIRE_LEN) out.storeId = r.string();
    else if (field === 2 && wire === WIRE_LEN) out.key = r.string();
    else r.skip(wire);
  }
  return out;
}

export function encodeGetObjectResponse(value: VssKeyValue): Uint8Array {
  const w = new Writer();
  w.message(2, encodeKeyValue(value));
  return w.finish();
}

// DeleteObjectRequest { store_id=1 string, key_value=2 KeyValue }. Mirrors encodeDeleteObjectRequest;
// used by the in-memory test server to actually remove a key (the real vss-server implements delete).
export function decodeDeleteObjectRequest(buf: Uint8Array): { storeId: string; keyValue: VssKeyValue } {
  const r = new Reader(buf);
  let storeId = "";
  let keyValue: VssKeyValue = { key: "", version: 0, value: new Uint8Array(0) };
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === WIRE_LEN) storeId = r.string();
    else if (field === 2 && wire === WIRE_LEN) keyValue = decodeKeyValue(r.bytes());
    else r.skip(wire);
  }
  return { storeId, keyValue };
}

export interface DecodedPutObjectRequest {
  storeId: string;
  globalVersion?: number;
  transactionItems: VssKeyValue[];
  deleteItems: VssKeyValue[];
}

export function decodePutObjectRequest(buf: Uint8Array): DecodedPutObjectRequest {
  const r = new Reader(buf);
  const out: DecodedPutObjectRequest = { storeId: "", transactionItems: [], deleteItems: [] };
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === WIRE_LEN) out.storeId = r.string();
    else if (field === 2 && wire === WIRE_VARINT) out.globalVersion = r.varint();
    else if (field === 3 && wire === WIRE_LEN) out.transactionItems.push(decodeKeyValue(r.bytes()));
    else if (field === 4 && wire === WIRE_LEN) out.deleteItems.push(decodeKeyValue(r.bytes()));
    else r.skip(wire);
  }
  return out;
}

export function decodeListKeyVersionsRequest(buf: Uint8Array): {
  storeId: string;
  keyPrefix?: string;
  pageSize?: number;
  pageToken?: string;
} {
  const r = new Reader(buf);
  const out: { storeId: string; keyPrefix?: string; pageSize?: number; pageToken?: string } = { storeId: "" };
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === WIRE_LEN) out.storeId = r.string();
    else if (field === 2 && wire === WIRE_LEN) out.keyPrefix = r.string();
    else if (field === 3 && wire === WIRE_VARINT) out.pageSize = r.varint();
    else if (field === 4 && wire === WIRE_LEN) out.pageToken = r.string();
    else r.skip(wire);
  }
  return out;
}

export function encodeListKeyVersionsResponse(
  keyVersions: VssKeyValue[],
  opts?: { nextPageToken?: string; globalVersion?: number },
): Uint8Array {
  const w = new Writer();
  for (const kv of keyVersions) w.message(1, encodeKeyValue(kv));
  w.string(2, opts?.nextPageToken);
  w.optionalInt64(3, opts?.globalVersion);
  return w.finish();
}

export function encodeErrorResponse(errorCode: number, message: string): Uint8Array {
  const w = new Writer();
  w.int64(1, errorCode);
  w.string(2, message);
  return w.finish();
}
