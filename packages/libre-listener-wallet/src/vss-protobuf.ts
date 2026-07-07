// Minimal, dependency-free protobuf codec for the VSS (Versioned Storage Service)
// wire messages — just enough of proto3 to talk to the open-source `lightningdevkit/vss-server`
// (KeyValueStore service) without pulling a protobuf runtime into a browser/SW bundle.
// Same "embed a tiny proto by hand" approach the lsps2-server uses for lnd's router.proto.
//
// Field tags come straight from vss-client's generated types (api/proto/vss.proto):
//   KeyValue                { key=1 string, version=2 int64, value=3 bytes }
//   GetObjectRequest        { store_id=1 string, key=2 string }
//   GetObjectResponse       { value=2 KeyValue }
//   PutObjectRequest        { store_id=1 string, global_version=2 int64?, transaction_items=3 rep KeyValue, delete_items=4 rep KeyValue }
//   DeleteObjectRequest     { store_id=1 string, key_value=2 KeyValue }
//   ListKeyVersionsRequest  { store_id=1 string, key_prefix=2 string?, page_size=3 int32?, page_token=4 string? }
//   ListKeyVersionsResponse { key_versions=1 rep KeyValue, next_page_token=2 string?, global_version=3 int64? }
//   ErrorResponse           { error_code=1 enum, message=2 string }
//
// proto3 semantics we honor: a plain (non-`optional`) scalar equal to its default (0 / "" / empty)
// is NOT serialized; the server reads its absence as the default. This is exactly what the reference
// Rust/prost client emits — e.g. a brand-new key is written with version 0, encoded as omitted.

export const VSS_ERROR_CODE = {
  Unknown: 0,
  ConflictException: 1,
  InvalidRequestException: 2,
  InternalServerException: 3,
  NoSuchKeyException: 4,
  AuthException: 5,
} as const;

export interface VssKeyValue {
  key: string;
  // int64 optimistic-concurrency version. 0 = a new key; the server bumps to version+1 on success.
  version: number;
  value: Uint8Array;
}

const WIRE_VARINT = 0;
const WIRE_LEN = 2;

// --- writer ---

class Writer {
  private out: number[] = [];

  // Unsigned varint for tags and length prefixes (always small, non-negative).
  private varint(nRaw: number): void {
    // Use division/modulo (not bitwise): JS bitwise ops coerce to int32, so `n & 0x7f` would
    // corrupt any value above 2^31. This way lengths up to 2^53 encode correctly.
    let n = nRaw;
    if (n < 0) throw new Error("vss-protobuf: negative varint not supported");
    while (n > 0x7f) {
      this.out.push((n % 128) + 0x80);
      n = Math.floor(n / 128);
    }
    this.out.push(n);
  }

  // int64 varint via BigInt so the FULL signed 64-bit range encodes correctly — including the
  // blind-write sentinel version = -1 (encoded as the 10-byte two's-complement all-ones varint,
  // exactly like protobuf/prost), which LDK's own VssStore sends to skip the server version check.
  private varintI64(vRaw: bigint): void {
    let u = vRaw < 0n ? vRaw + (1n << 64n) : vRaw; // two's-complement into unsigned 64-bit
    while (u > 0x7fn) {
      this.out.push(Number(u & 0x7fn) | 0x80);
      u >>= 7n;
    }
    this.out.push(Number(u));
  }

  private tag(field: number, wire: number): void {
    this.varint(field * 8 + wire);
  }

  int64(field: number, value: number): void {
    if (value === 0) return; // proto3 default — omit
    this.tag(field, WIRE_VARINT);
    this.varintI64(BigInt(value));
  }

  // Like int64 but for `optional` fields: encodes even a 0 when explicitly provided.
  optionalInt64(field: number, value: number | undefined): void {
    if (value === undefined) return;
    this.tag(field, WIRE_VARINT);
    this.varintI64(BigInt(value));
  }

  string(field: number, value: string | undefined): void {
    if (value === undefined || value.length === 0) return;
    this.rawBytes(field, utf8Encode(value));
  }

  bytes(field: number, value: Uint8Array): void {
    if (value.length === 0) return;
    this.rawBytes(field, value);
  }

  message(field: number, encoded: Uint8Array): void {
    this.rawBytes(field, encoded);
  }

  private rawBytes(field: number, value: Uint8Array): void {
    this.tag(field, WIRE_LEN);
    this.varint(value.length);
    for (let i = 0; i < value.length; i++) this.out.push(value[i]);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

// --- reader ---

class Reader {
  private pos = 0;
  constructor(private buf: Uint8Array) {}

  eof(): boolean {
    return this.pos >= this.buf.length;
  }

  varint(): number {
    let result = 0;
    let multiplier = 1;
    for (;;) {
      if (this.pos >= this.buf.length) throw new Error("vss-protobuf: truncated varint");
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * multiplier;
      if ((b & 0x80) === 0) break;
      multiplier *= 128;
    }
    return result;
  }

  tag(): { field: number; wire: number } {
    const t = this.varint();
    return { field: Math.floor(t / 8), wire: t & 7 };
  }

  bytes(): Uint8Array {
    const len = this.varint();
    if (this.pos + len > this.buf.length) throw new Error("vss-protobuf: truncated length-delimited field");
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  string(): string {
    return utf8Decode(this.bytes());
  }

  // Skip a field we don't care about, keeping the reader aligned.
  skip(wire: number): void {
    if (wire === WIRE_VARINT) this.varint();
    else if (wire === WIRE_LEN) this.bytes();
    else if (wire === 5) this.pos += 4;
    else if (wire === 1) this.pos += 8;
    else throw new Error(`vss-protobuf: unsupported wire type ${wire}`);
  }
}

function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

// --- message encoders (requests we send) ---

export function encodeKeyValue(kv: VssKeyValue): Uint8Array {
  const w = new Writer();
  w.string(1, kv.key);
  w.int64(2, kv.version);
  w.bytes(3, kv.value);
  return w.finish();
}

export function encodeGetObjectRequest(storeId: string, key: string): Uint8Array {
  const w = new Writer();
  w.string(1, storeId);
  w.string(2, key);
  return w.finish();
}

export function encodePutObjectRequest(req: {
  storeId: string;
  globalVersion?: number;
  transactionItems: VssKeyValue[];
  deleteItems?: VssKeyValue[];
}): Uint8Array {
  const w = new Writer();
  w.string(1, req.storeId);
  w.optionalInt64(2, req.globalVersion);
  for (const kv of req.transactionItems) w.message(3, encodeKeyValue(kv));
  for (const kv of req.deleteItems ?? []) w.message(4, encodeKeyValue(kv));
  return w.finish();
}

export function encodeDeleteObjectRequest(storeId: string, keyValue: VssKeyValue): Uint8Array {
  const w = new Writer();
  w.string(1, storeId);
  w.message(2, encodeKeyValue(keyValue));
  return w.finish();
}

export function encodeListKeyVersionsRequest(req: {
  storeId: string;
  keyPrefix?: string;
  pageSize?: number;
  pageToken?: string;
}): Uint8Array {
  const w = new Writer();
  w.string(1, req.storeId);
  w.string(2, req.keyPrefix);
  w.optionalInt64(3, req.pageSize);
  w.string(4, req.pageToken);
  return w.finish();
}

// --- message decoders (responses we receive) ---

export function decodeKeyValue(buf: Uint8Array): VssKeyValue {
  const r = new Reader(buf);
  const kv: VssKeyValue = { key: "", version: 0, value: new Uint8Array(0) };
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === WIRE_LEN) kv.key = r.string();
    else if (field === 2 && wire === WIRE_VARINT) kv.version = r.varint();
    else if (field === 3 && wire === WIRE_LEN) kv.value = new Uint8Array(r.bytes());
    else r.skip(wire);
  }
  return kv;
}

// GetObjectResponse.value is field 2 (not 1). Returns null if the value sub-message is absent.
export function decodeGetObjectResponse(buf: Uint8Array): VssKeyValue | null {
  const r = new Reader(buf);
  let kv: VssKeyValue | null = null;
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 2 && wire === WIRE_LEN) kv = decodeKeyValue(r.bytes());
    else r.skip(wire);
  }
  return kv;
}

export interface ListKeyVersionsResult {
  keyVersions: VssKeyValue[];
  nextPageToken?: string;
  globalVersion?: number;
}

export function decodeListKeyVersionsResponse(buf: Uint8Array): ListKeyVersionsResult {
  const r = new Reader(buf);
  const out: ListKeyVersionsResult = { keyVersions: [] };
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === WIRE_LEN) out.keyVersions.push(decodeKeyValue(r.bytes()));
    else if (field === 2 && wire === WIRE_LEN) out.nextPageToken = r.string();
    else if (field === 3 && wire === WIRE_VARINT) out.globalVersion = r.varint();
    else r.skip(wire);
  }
  return out;
}

export interface VssErrorResponse {
  errorCode: number;
  message: string;
}

export function decodeErrorResponse(buf: Uint8Array): VssErrorResponse {
  const r = new Reader(buf);
  const out: VssErrorResponse = { errorCode: 0, message: "" };
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === WIRE_VARINT) out.errorCode = r.varint();
    else if (field === 2 && wire === WIRE_LEN) out.message = r.string();
    else r.skip(wire);
  }
  return out;
}
