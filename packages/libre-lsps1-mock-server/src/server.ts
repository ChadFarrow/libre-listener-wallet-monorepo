// A real HTTP server wrapping the mock LSPS1 provider, so a browser (the PWA / extension "get a
// channel from an LSP" flow) can point its LSPS1 REST base URL at http://127.0.0.1:<port><base>
// and click through create-order → poll → completed without a real LSP, real money, or docker.
// Built on Node's stdlib http (no Express) — a CORS-enabled adapter over the pure routeMockLsps1.
import { createServer, type Server } from "node:http";
import { MockLsps1Provider, type MockLsps1Config } from "./mock-provider";
import { routeMockLsps1 } from "./http-router";

export interface MockLsps1ServerOptions {
  port?: number;
  // The URL prefix the routes mount under (mirrors real LSPs' versioned base, e.g. Megalith's
  // /api/lsps1/v1). The client's baseUrl must be `http://host:port${basePath}`.
  basePath?: string;
  provider?: MockLsps1Provider;
  config?: MockLsps1Config;
  logger?: { info?: (m: string) => void; error?: (m: string) => void };
}

export interface RunningMockLsps1Server {
  provider: MockLsps1Provider;
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
}

// Localhost-only by design (dev tool; never expose a mock LSP publicly). Binds 127.0.0.1.
export function startMockLsps1Server(
  options: MockLsps1ServerOptions = {}
): Promise<RunningMockLsps1Server> {
  const basePath = normalizeBase(options.basePath ?? "/mock-lsps1/v1");
  const provider = options.provider ?? new MockLsps1Provider(options.config);
  const log = options.logger ?? { info: (m: string) => console.log(m), error: (m: string) => console.error(m) };

  const server: Server = createServer((req, res) => {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) || "/" : url.pathname;

    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      let body: unknown;
      if (chunks.length) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.writeHead(400, { ...cors, "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
          return;
        }
      }
      let result;
      try {
        result = routeMockLsps1(provider, req.method ?? "GET", path, url.searchParams, body);
      } catch (e) {
        log.error?.(`[mock-lsps1] route error: ${(e as Error)?.message ?? e}`);
        res.writeHead(500, { ...cors, "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Internal mock error" }));
        return;
      }
      log.info?.(`[mock-lsps1] ${req.method} ${path} → ${result.status}`);
      res.writeHead(result.status, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify(result.body));
    });
  });

  const port = options.port ?? 9098;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const baseUrl = `http://127.0.0.1:${port}${basePath}`;
      log.info?.(`[mock-lsps1] listening — LSPS1 REST base: ${baseUrl}`);
      resolve({
        provider,
        port,
        baseUrl,
        close: () =>
          new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

function normalizeBase(base: string): string {
  let b = base.startsWith("/") ? base : `/${base}`;
  b = b.replace(/\/$/, "");
  return b;
}
