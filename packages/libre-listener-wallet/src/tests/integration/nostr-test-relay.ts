// Minimal in-process Nostr relay for tests — just enough of the relay protocol (EVENT / REQ / CLOSE
// with EOSE and OK) to carry NIP-47 (NWC) traffic between the wallet's NwcManager and a test client,
// so a soak can drive the REAL NWC flow with no external relay. Not a general-purpose relay.
import { WebSocketServer, WebSocket } from "ws";
import { AddressInfo } from "net";

export interface NostrEvent {
  id: string;
  pubkey: string;
  kind: number;
  tags: string[][];
  content: string;
  created_at: number;
  sig: string;
}
type Filter = { kinds?: number[]; authors?: string[]; ids?: number[] | string[]; since?: number; until?: number; [tagKey: string]: unknown };

function matches(ev: NostrEvent, filter: Filter): boolean {
  if (filter.kinds && !filter.kinds.includes(ev.kind)) return false;
  if (filter.authors && !(filter.authors as string[]).includes(ev.pubkey)) return false;
  if (filter.ids && !(filter.ids as string[]).includes(ev.id)) return false;
  if (typeof filter.since === "number" && ev.created_at < filter.since) return false;
  if (typeof filter.until === "number" && ev.created_at > filter.until) return false;
  for (const [k, vals] of Object.entries(filter)) {
    if (k.startsWith("#")) {
      const tagName = k.slice(1);
      const evTagVals = ev.tags.filter((t) => t[0] === tagName).map((t) => t[1]);
      if (!(vals as string[]).some((v) => evTagVals.includes(v))) return false;
    }
  }
  return true;
}

export interface NostrTestRelay {
  url: string;
  events: NostrEvent[];
  close(): Promise<void>;
}

export async function startNostrTestRelay(): Promise<NostrTestRelay> {
  const events: NostrEvent[] = [];
  const subs = new Map<WebSocket, Map<string, Filter[]>>(); // ws -> subId -> filters
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });

  wss.on("connection", (ws) => {
    subs.set(ws, new Map());
    ws.on("message", (data) => {
      let msg: unknown[];
      try { msg = JSON.parse(data.toString()); } catch { return; }
      const [type, ...rest] = msg as [string, ...unknown[]];
      if (type === "EVENT") {
        const ev = rest[0] as NostrEvent;
        events.push(ev);
        ws.send(JSON.stringify(["OK", ev.id, true, ""]));
        for (const [client, clientSubs] of subs) {
          if (client.readyState !== WebSocket.OPEN) continue;
          for (const [subId, filters] of clientSubs) {
            if (filters.some((f) => matches(ev, f))) client.send(JSON.stringify(["EVENT", subId, ev]));
          }
        }
      } else if (type === "REQ") {
        const subId = rest[0] as string;
        const filters = rest.slice(1) as Filter[];
        subs.get(ws)!.set(subId, filters);
        for (const ev of events) if (filters.some((f) => matches(ev, f))) ws.send(JSON.stringify(["EVENT", subId, ev]));
        ws.send(JSON.stringify(["EOSE", subId]));
      } else if (type === "CLOSE") {
        subs.get(ws)!.delete(rest[0] as string);
      }
    });
    ws.on("close", () => subs.delete(ws));
    ws.on("error", () => { /* ignore client socket errors in tests */ });
  });

  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  const port = (wss.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    events,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}
