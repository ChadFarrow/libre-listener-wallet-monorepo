// Client for the open-source LDK Versioned Storage Service (`lightningdevkit/vss-server`).
// VSS is a versioned, encrypted-at-rest-agnostic KV store: every key carries a monotonic int64
// version and a PutObjects only succeeds if the request version matches the server's current one
// (else HTTP 409 / ConflictException). That optimistic-concurrency check is the whole point here —
// it lets a second instance (or a stale/reset local replica) be REJECTED server-side instead of
// replaying old channel state at the peer and triggering a force-close, which is a guarantee our
// per-origin Web Lock structurally cannot provide.
//
// This client speaks the raw protobuf-over-HTTP binding (POST application/octet-stream to
// /getObject, /putObjects, /listKeyVersions, /deleteObject) via the dependency-free codec in
// ./vss-protobuf. It does NOT encrypt — callers pass ciphertext (the SDK wraps values with the
// seed-derived key via state-backup.ts before they ever reach here, per the key-isolation guardrail).
import {
  encodeGetObjectRequest,
  decodeGetObjectResponse,
  encodePutObjectRequest,
  encodeDeleteObjectRequest,
  encodeListKeyVersionsRequest,
  decodeListKeyVersionsResponse,
  decodeErrorResponse,
  VSS_ERROR_CODE,
  type VssKeyValue,
  type ListKeyVersionsResult,
} from "./vss-protobuf";

export type { VssKeyValue, ListKeyVersionsResult } from "./vss-protobuf";

export interface VssLogger {
  info?: (m: string) => void;
  warn?: (m: string) => void;
  error?: (m: string) => void;
}

export interface VssClientConfig {
  baseUrl: string; // e.g. https://vss.example.com/vss
  // Per-wallet namespace on the server. MUST be stable for a given wallet and unique across wallets
  // (derive it from the seed, never the raw seed itself) so two wallets never share a version line.
  storeId: string;
  fetchImpl?: typeof fetch;
  logger?: VssLogger;
}

// Typed error so callers can branch on conflict (stale write) vs not-found vs everything else.
export class VssError extends Error {
  readonly code: number; // one of VSS_ERROR_CODE.*, or -1 when the body couldn't be decoded
  readonly httpStatus: number;
  constructor(message: string, code: number, httpStatus: number) {
    super(message);
    this.name = "VssError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function isVssConflict(e: unknown): e is VssError {
  return e instanceof VssError && (e.code === VSS_ERROR_CODE.ConflictException || e.httpStatus === 409);
}

export function isVssNotFound(e: unknown): e is VssError {
  return e instanceof VssError && (e.code === VSS_ERROR_CODE.NoSuchKeyException || e.httpStatus === 404);
}

const APPLICATION_OCTET_STREAM = "application/octet-stream";

export class VssClient {
  private base: string;
  private storeId: string;
  private fetchImpl: typeof fetch;
  private logger?: VssLogger;

  constructor(cfg: VssClientConfig) {
    this.base = cfg.baseUrl.replace(/\/$/, "");
    this.storeId = cfg.storeId;
    // Bind to globalThis: a browser's global `fetch` throws "Illegal invocation" if invoked with a
    // non-Window receiver (e.g. as `this.fetchImpl(url)`). Injected impls (tests) are used as-is.
    this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.logger = cfg.logger;
  }

  private async rpc(path: string, body: Uint8Array): Promise<Uint8Array> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: "POST",
      headers: { "content-type": APPLICATION_OCTET_STREAM },
      body: body as unknown as BodyInit,
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!res.ok) {
      let code = -1;
      let message = res.statusText || `HTTP ${res.status}`;
      try {
        const err = decodeErrorResponse(buf);
        code = err.errorCode;
        if (err.message) message = err.message;
      } catch {
        // Non-protobuf error body (e.g. a proxy's HTML 502) — keep the status-line message.
      }
      throw new VssError(`VSS ${path} → ${res.status}: ${message}`, code, res.status);
    }
    return buf;
  }

  // Fetch a key's current value+version, or null if it doesn't exist yet.
  async getObject(key: string): Promise<VssKeyValue | null> {
    try {
      const buf = await this.rpc("/getObject", encodeGetObjectRequest(this.storeId, key));
      return decodeGetObjectResponse(buf);
    } catch (e) {
      if (isVssNotFound(e)) return null;
      throw e;
    }
  }

  // Atomically write (and/or delete) a batch. Each item's `version` must equal the server's current
  // version for that key (0 for a brand-new key); on success the server stores version+1. A stale
  // version throws a VssError for which isVssConflict(e) is true — the caller must NOT proceed as if
  // the write landed. Pass the whole channel-critical set together so they advance as one unit.
  async putObjects(
    transactionItems: VssKeyValue[],
    opts?: { deleteItems?: VssKeyValue[]; globalVersion?: number },
  ): Promise<void> {
    await this.rpc(
      "/putObjects",
      encodePutObjectRequest({
        storeId: this.storeId,
        globalVersion: opts?.globalVersion,
        transactionItems,
        deleteItems: opts?.deleteItems,
      }),
    );
  }

  async deleteObject(keyValue: VssKeyValue): Promise<void> {
    await this.rpc("/deleteObject", encodeDeleteObjectRequest(this.storeId, keyValue));
  }

  // List keys (optionally by prefix) with their versions but WITHOUT values — cheap way to compare
  // the local high-water against the server's before deciding to re-hydrate or halt at start().
  async listKeyVersions(opts?: {
    keyPrefix?: string;
    pageSize?: number;
    pageToken?: string;
  }): Promise<ListKeyVersionsResult> {
    const buf = await this.rpc(
      "/listKeyVersions",
      encodeListKeyVersionsRequest({ storeId: this.storeId, ...opts }),
    );
    return decodeListKeyVersionsResponse(buf);
  }

  // Enumerate every key/version across pages (VSS paginates listKeyVersions).
  async listAllKeyVersions(keyPrefix?: string): Promise<VssKeyValue[]> {
    const all: VssKeyValue[] = [];
    let pageToken: string | undefined;
    for (;;) {
      const page = await this.listKeyVersions({ keyPrefix, pageToken });
      all.push(...page.keyVersions);
      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }
    return all;
  }
}
