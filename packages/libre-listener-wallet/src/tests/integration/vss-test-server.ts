// In-process, in-memory VSS server for tests — implements the same protobuf-over-HTTP API the real
// `lightningdevkit/vss-server` exposes (POST /getObject | /putObjects | /listKeyVersions |
// /deleteObject), so a soak can exercise the wallet's real VssClient + mirror + re-hydrate path
// end-to-end WITHOUT docker/Postgres. Decodes/encodes with the SDK's own vss-protobuf codec, so the
// wire format is validated too. Blind writes (version -1) overwrite; a matching non-negative version
// enforces optimistic concurrency (bumping to version+1) — enough to model the real server for tests.
import * as http from "http";
import { AddressInfo } from "net";
import {
  decodeDeleteObjectRequest,
  decodeGetObjectRequest,
  encodeGetObjectResponse,
  decodePutObjectRequest,
  decodeListKeyVersionsRequest,
  encodeListKeyVersionsResponse,
  encodeErrorResponse,
} from "./vss-protobuf-server";
import { VSS_ERROR_CODE } from "../../vss-protobuf";

interface StoredValue { version: number; value: Uint8Array }

export interface VssTestServer {
  url: string;
  // store id -> (key -> {version,value})
  stores: Map<string, Map<string, StoredValue>>;
  getValue(storeId: string, key: string): Uint8Array | undefined;
  close(): Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

export async function startVssTestServer(): Promise<VssTestServer> {
  const stores = new Map<string, Map<string, StoredValue>>();
  const storeFor = (id: string) => {
    let s = stores.get(id);
    if (!s) { s = new Map(); stores.set(id, s); }
    return s;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const body = await readBody(req);
      const path = req.url || "";
      if (path.endsWith("/getObject")) {
        const { storeId, key } = decodeGetObjectRequest(body);
        const val = storeFor(storeId).get(key);
        if (!val) {
          res.writeHead(404, { "content-type": "application/octet-stream" });
          res.end(Buffer.from(encodeErrorResponse(VSS_ERROR_CODE.NoSuchKeyException, "no such key")));
          return;
        }
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from(encodeGetObjectResponse({ key, version: val.version, value: val.value })));
        return;
      }
      if (path.endsWith("/putObjects")) {
        const { storeId, transactionItems, deleteItems } = decodePutObjectRequest(body);
        const store = storeFor(storeId);
        // Validate versions first (all-or-nothing, like the real server's transaction).
        for (const it of transactionItems) {
          if (it.version < 0) continue; // blind write — always allowed
          const cur = store.get(it.key)?.version ?? 0;
          if (it.version !== cur) {
            res.writeHead(409, { "content-type": "application/octet-stream" });
            res.end(Buffer.from(encodeErrorResponse(VSS_ERROR_CODE.ConflictException, `version conflict on ${it.key}`)));
            return;
          }
        }
        for (const it of transactionItems) {
          const cur = store.get(it.key)?.version ?? 0;
          const nextVersion = it.version < 0 ? cur + 1 : it.version + 1;
          store.set(it.key, { version: nextVersion, value: it.value });
        }
        for (const d of deleteItems) store.delete(d.key);
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from(new Uint8Array(0)));
        return;
      }
      if (path.endsWith("/listKeyVersions")) {
        const { storeId, keyPrefix } = decodeListKeyVersionsRequest(body);
        const store = storeFor(storeId);
        const items = [...store.entries()]
          .filter(([k]) => !keyPrefix || k.startsWith(keyPrefix))
          .map(([key, v]) => ({ key, version: v.version, value: new Uint8Array(0) }));
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from(encodeListKeyVersionsResponse(items)));
        return;
      }
      if (path.endsWith("/deleteObject")) {
        const { storeId, keyValue } = decodeDeleteObjectRequest(body);
        storeFor(storeId).delete(keyValue.key);
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from(new Uint8Array(0)));
        return;
      }
      res.writeHead(404);
      res.end();
    } catch (e) {
      res.writeHead(500);
      res.end(String(e instanceof Error ? e.message : e));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    stores,
    getValue: (storeId, key) => stores.get(storeId)?.get(key)?.value,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
