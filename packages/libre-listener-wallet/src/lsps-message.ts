// LSPS0 / bLIP-50 wire format for LSPS messages carried as a BOLT8 peer custom message (type 37913).
// The message body is a JSON-RPC 2.0 object encoded as UTF-8. LDK's PeerManager frames the message
// and prepends the 2-byte type from Type.type_id(); Type.write() returns ONLY this body — no
// length/type prefix.

export const LSPS_PEER_MSG_TYPE = 37913;

export interface JsonRpcRequestObj {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: unknown;
}

export interface JsonRpcResponseObj {
  id: string;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeLspsMessage(obj: unknown): Uint8Array {
  return enc.encode(JSON.stringify(obj));
}

export function decodeLspsMessage(bytes: Uint8Array): any {
  return JSON.parse(dec.decode(bytes));
}

export function buildRequest(method: string, params: unknown, id: string): JsonRpcRequestObj {
  return { jsonrpc: "2.0", id, method, params };
}

// Normalize a decoded JSON-RPC response to { id, result?, error? }. Returns null when the object has
// no string id (e.g. a notification) — the caller ignores those.
export function parseResponse(obj: any): JsonRpcResponseObj | null {
  if (!obj || typeof obj.id !== "string") return null;
  const out: JsonRpcResponseObj = { id: obj.id };
  if ("result" in obj) out.result = obj.result;
  if (obj.error) out.error = obj.error;
  return out;
}

export function newRequestId(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("hex string must have even length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid hex");
    out[i] = byte;
  }
  return out;
}
