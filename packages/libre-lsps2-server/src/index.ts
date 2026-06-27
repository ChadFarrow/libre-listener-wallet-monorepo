import express from "express";
import cors from "cors";
import type { Server } from "http";
import { handleJsonRpc } from "./jsonrpc";
import type { LspBackend, JsonRpcRequest } from "./jsonrpc";

export * from "./jsonrpc";
export * from "./lnd-client";
export * from "./bitcoind-client";
export * from "./backend";
export * from "./config";

export interface Logger { info(m: string): void; error(m: string): void; }

export class LibreLsps2Server {
  private app = express();
  private server?: Server;
  constructor(private deps: { backend: LspBackend; logger?: Logger }) {
    this.app.use(cors());
    this.app.use(express.json());
    this.app.post("/lsps2", async (req, res) => {
      try {
        const response = await handleJsonRpc(req.body as JsonRpcRequest, this.deps.backend);
        res.json(response);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.deps.logger?.error(`lsps2 request failed: ${message}`);
        res.json({ jsonrpc: "2.0", id: (req.body as any)?.id ?? null, error: { code: -32000, message } });
      }
    });
    this.app.get("/health", (_req, res) => res.json({ ok: true }));
  }

  start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.app
        .listen(port, "127.0.0.1", () => {
          this.deps.logger?.info(`LSPS2 onboarding server on http://127.0.0.1:${port}/lsps2`);
          resolve();
        })
        .on("error", reject);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
