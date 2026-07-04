// LSPS1 (bLIP-51 buy-a-channel) over the plain-REST HTTP binding used by real mainnet LSPs
// (Megalith, Olympus/ZEUS): GET /get_info, POST /create_order, GET /get_order?order_id=. Unlike the
// regtest dev LSP (single-endpoint JSON-RPC), there is NO {jsonrpc,id,method,params} envelope — the
// request body is the bare params object and the response is the bare result. Sat amounts are strings.
import type { Lsps1RestGetInfoResponse, Lsps1RestCreateOrderRequest, Lsps1RestOrderResponse } from "@libre/shared";

export interface Lsps1RestClientConfig {
  baseUrl: string; // e.g. https://megalithic.me/api/lsps1/v1
  fetchImpl?: typeof fetch;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
}

// Lease duration to request: caller's choice clamped to [1, LSP max], defaulting to the LSP max
// (longest guaranteed channel lifetime per open fee — right for an infrequently-online wallet).
export function clampExpiryBlocks(requested: number | undefined, maxBlocks: number): number {
  const want = requested ?? maxBlocks;
  return Math.min(maxBlocks, Math.max(1, want));
}

export function isOrderComplete(o: Lsps1RestOrderResponse): boolean {
  return o.order_state === "COMPLETED";
}
export function isOrderFailed(o: Lsps1RestOrderResponse): boolean {
  return o.order_state === "FAILED";
}
export function orderInvoice(o: Lsps1RestOrderResponse): string | undefined {
  return o.payment?.bolt11?.invoice;
}

export class Lsps1RestClient {
  private base: string;
  private fetchImpl: typeof fetch;
  private logger?: Lsps1RestClientConfig["logger"];

  constructor(cfg: Lsps1RestClientConfig) {
    this.base = cfg.baseUrl.replace(/\/$/, "");
    // Bind to globalThis: a browser's global `fetch` throws "Illegal invocation" if invoked with a
    // non-Window receiver (e.g. as `this.fetchImpl(url)`). Injected impls (tests) are used as-is.
    this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.logger = cfg.logger;
  }

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(url, init);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`LSPS1 REST ${init?.method ?? "GET"} ${url} → ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  getInfo(): Promise<Lsps1RestGetInfoResponse> {
    return this.json<Lsps1RestGetInfoResponse>(`${this.base}/get_info`);
  }

  createOrder(body: Lsps1RestCreateOrderRequest): Promise<Lsps1RestOrderResponse> {
    return this.json<Lsps1RestOrderResponse>(`${this.base}/create_order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  getOrder(orderId: string): Promise<Lsps1RestOrderResponse> {
    return this.json<Lsps1RestOrderResponse>(`${this.base}/get_order?order_id=${encodeURIComponent(orderId)}`);
  }
}
