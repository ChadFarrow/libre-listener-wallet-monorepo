// A stateful, framework-agnostic mock of a mainnet LSPS1-over-REST provider (Megalith / Olympus).
// It answers the exact bLIP-51 REST shapes the SDK's `Lsps1RestClient` speaks — GET /get_info,
// POST /create_order, GET /get_order?order_id= — so `LibreListenerWallet.purchaseLSPS1Capacity`
// and `getLSPS1Order` drive it unchanged. No Lightning, no on-chain, no real money: it mints a
// placeholder BOLT11 and walks the order through its lifecycle so the PWA/extension "get a channel
// from an LSP" UI can be built and tested offline and deterministically.
//
// Two consumers share this ONE core: `msw.ts` wraps it as MSW handlers for vitest, and `server.ts`
// wraps it as a real HTTP server the browser can hit. Keep the wire shapes here in sync with
// @libre/shared Lsps1Rest* — that's the contract the real LSPs and the client both honor.
import type {
  Lsps1RestGetInfoResponse,
  Lsps1RestCreateOrderRequest,
  Lsps1RestOrderResponse,
} from "@libre/shared";

// Thrown for a request the LSP would reject (bad amount, unknown order). The HTTP/MSW layers map
// this to a non-2xx response with a body, which is what `Lsps1RestClient.json` turns back into an
// Error — so the client's error path is exercised, not bypassed.
export class MockLspError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "MockLspError";
  }
}

export interface MockLsps1Config {
  // Channel-size bounds (sat). Defaults mirror Megalith's live get_info.
  minChannelSat?: number;
  maxChannelSat?: number;
  maxChannelExpiryBlocks?: number;
  // 0 advertises a zero-conf-capable LSP (Megalith); 3 mirrors Olympus.
  minRequiredChannelConfirmations?: number;
  // Opening fee = feeBaseSat + ceil(lsp_balance_sat * feePpm / 1e6).
  feeBaseSat?: number;
  feePpm?: number;
  // The LSP node the client is told to dial (get_info `uris`). A loopback default keeps a browser
  // from trying to open a channel to a real node — the dial is best-effort and its failure is
  // caught + warned by purchaseLSPS1Capacity, so the order still gets placed.
  nodePubkey?: string;
  nodeHost?: string;
  nodePort?: number;
  // How the order advances after create_order. "manual" (default for tests): stays awaiting until
  // markPaid()/complete() is called. "timed": auto-walks awaiting → paid → completed off the clock,
  // so a hands-off browser demo shows the poller progress without a control call.
  advance?: "manual" | "timed";
  // For "timed": ms until PAID, and ms until COMPLETED (from order creation).
  paidAfterMs?: number;
  completedAfterMs?: number;
  // Injectable clock (ms) so "timed" is deterministic under test without fake timers.
  clock?: () => number;
}

interface MockOrder {
  order: Lsps1RestOrderResponse;
  createdAtMs: number;
  // Once a lifecycle step is forced manually it pins the state (manual mode, or a control override
  // in timed mode) so getOrder stops recomputing from the clock.
  pinned: boolean;
}

const DEFAULTS = {
  minChannelSat: 150_000,
  maxChannelSat: 16_000_000,
  maxChannelExpiryBlocks: 13_140,
  minRequiredChannelConfirmations: 0,
  feeBaseSat: 2_000,
  feePpm: 4_000,
  nodePubkey: "038a9e56512ec98da2b5789761f7af8f280baf98a09282360cd6ff1381b5e889bf",
  nodeHost: "127.0.0.1",
  nodePort: 9999,
  advance: "manual" as const,
  paidAfterMs: 4_000,
  completedAfterMs: 8_000,
};

export class MockLsps1Provider {
  private cfg: Required<MockLsps1Config>;
  private orders = new Map<string, MockOrder>();
  private seq = 0;
  // The most recent create_order body received — lets a test assert exactly what the app sent
  // (lease blocks, required confs, announce flag, client public_key) without a capturing handler.
  private lastCreateOrderReq?: Lsps1RestCreateOrderRequest;

  constructor(config: MockLsps1Config = {}) {
    this.cfg = {
      minChannelSat: config.minChannelSat ?? DEFAULTS.minChannelSat,
      maxChannelSat: config.maxChannelSat ?? DEFAULTS.maxChannelSat,
      maxChannelExpiryBlocks: config.maxChannelExpiryBlocks ?? DEFAULTS.maxChannelExpiryBlocks,
      minRequiredChannelConfirmations:
        config.minRequiredChannelConfirmations ?? DEFAULTS.minRequiredChannelConfirmations,
      feeBaseSat: config.feeBaseSat ?? DEFAULTS.feeBaseSat,
      feePpm: config.feePpm ?? DEFAULTS.feePpm,
      nodePubkey: config.nodePubkey ?? DEFAULTS.nodePubkey,
      nodeHost: config.nodeHost ?? DEFAULTS.nodeHost,
      nodePort: config.nodePort ?? DEFAULTS.nodePort,
      advance: config.advance ?? DEFAULTS.advance,
      paidAfterMs: config.paidAfterMs ?? DEFAULTS.paidAfterMs,
      completedAfterMs: config.completedAfterMs ?? DEFAULTS.completedAfterMs,
      clock: config.clock ?? (() => Date.now()),
    };
  }

  get uri(): string {
    return `${this.cfg.nodePubkey}@${this.cfg.nodeHost}:${this.cfg.nodePort}`;
  }

  feeForSats(lspBalanceSat: number): number {
    return this.cfg.feeBaseSat + Math.ceil((lspBalanceSat * this.cfg.feePpm) / 1_000_000);
  }

  getInfo(): Lsps1RestGetInfoResponse {
    return {
      min_channel_balance_sat: String(this.cfg.minChannelSat),
      max_channel_balance_sat: String(this.cfg.maxChannelSat),
      min_initial_client_balance_sat: "0",
      max_initial_client_balance_sat: "0",
      max_channel_expiry_blocks: this.cfg.maxChannelExpiryBlocks,
      min_required_channel_confirmations: this.cfg.minRequiredChannelConfirmations,
      min_funding_confirms_within_blocks: 6,
      supports_zero_channel_reserve: this.cfg.minRequiredChannelConfirmations === 0,
      uris: [this.uri],
    };
  }

  // The create_order request the app last sent (undefined until one arrives).
  get lastCreateOrder(): Lsps1RestCreateOrderRequest | undefined {
    return this.lastCreateOrderReq;
  }

  createOrder(body: Lsps1RestCreateOrderRequest): Lsps1RestOrderResponse {
    this.lastCreateOrderReq = body;
    const lspBalanceSat = Number(body.lsp_balance_sat);
    if (!Number.isFinite(lspBalanceSat) || lspBalanceSat <= 0) {
      throw new MockLspError(400, `Invalid lsp_balance_sat: ${body.lsp_balance_sat}`);
    }
    if (lspBalanceSat < this.cfg.minChannelSat || lspBalanceSat > this.cfg.maxChannelSat) {
      throw new MockLspError(
        400,
        `lsp_balance_sat ${lspBalanceSat} outside bounds [${this.cfg.minChannelSat}, ${this.cfg.maxChannelSat}]`
      );
    }

    this.seq += 1;
    const orderId = `mock-order-${this.seq}`;
    const feeTotalSat = this.feeForSats(lspBalanceSat);
    const now = this.cfg.clock();
    // A deterministic placeholder BOLT11 — NOT a real invoice. The UI only needs a string to render
    // (and QR); nothing decodes it here. Made obviously-fake so it can never be paid by accident.
    const invoice = `lnbcmock${feeTotalSat}n1p0${orderId.replace(/[^a-z0-9]/g, "")}`;

    const order: Lsps1RestOrderResponse = {
      order_id: orderId,
      order_state: "CREATED",
      lsp_balance_sat: body.lsp_balance_sat,
      client_balance_sat: body.client_balance_sat ?? "0",
      payment: {
        bolt11: {
          state: "EXPECT_PAYMENT",
          expires_at: new Date(now + 3_600_000).toISOString(),
          fee_total_sat: String(feeTotalSat),
          invoice,
        },
      },
      channel: null,
    };
    this.orders.set(orderId, { order, createdAtMs: now, pinned: this.cfg.advance === "manual" });
    return this.clone(order);
  }

  getOrder(orderId: string): Lsps1RestOrderResponse {
    const rec = this.orders.get(orderId);
    if (!rec) {
      throw new MockLspError(404, `Unknown order_id: ${orderId}`);
    }
    if (!rec.pinned && this.cfg.advance === "timed") {
      this.applyTimedAdvance(rec);
    }
    return this.clone(rec.order);
  }

  // --- Control plane (not LSPS1 — for driving states deterministically from tests or the dev UI) ---

  markPaid(orderId: string): Lsps1RestOrderResponse {
    const rec = this.require(orderId);
    this.setPaid(rec.order);
    rec.pinned = true;
    return this.clone(rec.order);
  }

  complete(orderId: string): Lsps1RestOrderResponse {
    const rec = this.require(orderId);
    this.setPaid(rec.order);
    rec.order.order_state = "COMPLETED";
    rec.order.channel = {
      funded_at: new Date(this.cfg.clock()).toISOString(),
      funding_outpoint: `${"0".repeat(64)}:0`,
      expires_at: new Date(this.cfg.clock() + 90 * 86_400_000).toISOString(),
    };
    rec.pinned = true;
    return this.clone(rec.order);
  }

  fail(orderId: string): Lsps1RestOrderResponse {
    const rec = this.require(orderId);
    rec.order.order_state = "FAILED";
    if (rec.order.payment?.bolt11) rec.order.payment.bolt11.state = "CANCELLED";
    rec.pinned = true;
    return this.clone(rec.order);
  }

  listOrders(): Lsps1RestOrderResponse[] {
    return [...this.orders.values()].map((r) => this.clone(r.order));
  }

  reset(): void {
    this.orders.clear();
    this.seq = 0;
    this.lastCreateOrderReq = undefined;
  }

  private applyTimedAdvance(rec: MockOrder): void {
    const elapsed = this.cfg.clock() - rec.createdAtMs;
    if (elapsed >= this.cfg.completedAfterMs) {
      this.setPaid(rec.order);
      rec.order.order_state = "COMPLETED";
      rec.order.channel = { funded_at: new Date(this.cfg.clock()).toISOString() };
    } else if (elapsed >= this.cfg.paidAfterMs) {
      this.setPaid(rec.order);
    }
  }

  private setPaid(order: Lsps1RestOrderResponse): void {
    if (order.payment?.bolt11) order.payment.bolt11.state = "PAID";
  }

  private require(orderId: string): MockOrder {
    const rec = this.orders.get(orderId);
    if (!rec) throw new MockLspError(404, `Unknown order_id: ${orderId}`);
    return rec;
  }

  private clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
  }
}
