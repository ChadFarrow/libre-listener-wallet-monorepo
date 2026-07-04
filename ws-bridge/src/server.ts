import { WebSocketServer, type WebSocket, type RawData } from "ws";
import net from "node:net";
import { isTargetAllowed, parseTarget } from "./allowlist";

export interface BridgeConfig {
  port: number;
  allowlist: Set<string>;
  fallbackTarget?: string; // used when the client sends no ?target (back-compat with old single-target)
  allowPrivate?: boolean; // test-only: permit loopback targets
  maxConnsPerIp?: number; // default 8
  log?: (m: string) => void;
}

export function startBridge(cfg: BridgeConfig): { ready: Promise<number>; close: () => Promise<void> } {
  const log = cfg.log ?? ((m: string) => console.log(`[ws-bridge] ${m}`));
  const maxPerIp = cfg.maxConnsPerIp ?? 8;
  const perIp = new Map<string, number>();
  const wss = new WebSocketServer({ port: cfg.port });

  const ready = new Promise<number>((resolve) =>
    wss.on("listening", () => resolve((wss.address() as net.AddressInfo).port))
  );

  wss.on("connection", (ws: WebSocket, req) => {
    const ip = req.socket.remoteAddress ?? "?";
    const url = new URL(req.url ?? "/", "http://localhost");
    const rawTarget = url.searchParams.get("target") ?? cfg.fallbackTarget ?? "";

    if (!isTargetAllowed(rawTarget, cfg.allowlist, { allowPrivate: cfg.allowPrivate })) {
      log(`reject ${ip} target=${rawTarget || "(none)"}: not allowed`);
      ws.close(1008, "target not allowed");
      return;
    }

    const cur = perIp.get(ip) ?? 0;
    if (cur >= maxPerIp) {
      log(`reject ${ip}: too many connections`);
      ws.close(1013, "too many connections");
      return;
    }
    perIp.set(ip, cur + 1);
    const release = () => {
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
    };

    const { host, port } = parseTarget(rawTarget)!;
    log(`open ${ip} -> ${host}:${port}`);
    const tcp = net.connect(port, host);

    tcp.on("data", (d) => {
      if (ws.readyState === ws.OPEN) ws.send(d);
    });
    tcp.on("close", () => ws.close());
    tcp.on("error", (e) => {
      log(`tcp error ${host}:${port}: ${e.message}`);
      ws.close(1011, "upstream error");
    });

    ws.on("message", (d: RawData) => {
      tcp.write(d as Buffer);
    });
    ws.on("close", () => {
      tcp.destroy();
      release();
    });
    ws.on("error", () => {
      tcp.destroy();
    });
  });

  return {
    ready,
    close: () =>
      new Promise<void>((resolve) => {
        // wss.close() only resolves once every open client connection has ended (Node's
        // server.close() semantics) — it will never resolve on its own while a proxied
        // session is still active. Terminate open clients first (this also destroys their
        // paired tcp socket via the "close" handler above) so shutdown is prompt and bounded.
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}
