export interface WalletConfig {
  network: "mainnet" | "testnet" | "regtest" | "signet";
  esploraUrl: string;
  rapidGossipSyncUrl?: string;
  // Accept/open announced (public) channels. Default false (private node).
  // Required to accept channels from counterparties that only open public
  // channels (e.g. the Mutinynet faucet).
  announceChannels?: boolean;
  // Optional node name broadcast in a node_announcement so peers display it
  // instead of "Unknown". Only propagates once a public channel is announced.
  // Max 32 bytes (UTF-8); longer names are truncated.
  alias?: string;
  // Pubkeys (hex) of LSPs/peers from which 0-conf (zero-confirmation) JIT channels
  // may be accepted. Accepting 0-conf from an unvetted node risks a double-spend, so
  // any peer NOT in this list gets a normal (confirmed) channel instead. Empty/unset
  // = never accept 0-conf.
  trustedZeroConfPeers?: string[];
  // Auto-redial channel peers when their connection drops (browser/PWA tabs sleep and
  // networks flap; a dropped peer silently disables sending). Exponential backoff while
  // the node runs. Default true; set false to disable.
  autoReconnectPeers?: boolean;
}

export interface NWCRequest {
  method: "get_info" | "get_balance" | "make_invoice" | "pay_invoice" | "pay_keysend";
  params: Record<string, any>;
}

export interface NWCResponse {
  result_type: string;
  error?: {
    code: string;
    message: string;
  };
  result?: Record<string, any>;
}

export interface LspProvider {
  name: string;
  pubkey: string;
  connection_string: string;
  api_url: string;
  protocols: ("lsps1" | "lsps2")[];
}

// JSON-RPC Generic Request/Response
export interface JsonRpcRequest<T = any> {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params: T;
}

export interface JsonRpcResponse<T = any> {
  jsonrpc: "2.0";
  id: string | number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

// LSPS2 JIT Channel interfaces
export interface Lsps2GetVersionsResponse {
  versions: number[];
}

export interface Lsps2OpeningFeeParams {
  opening_fee_params_id: string;
  min_fee_msat: string;
  proportional_fee_ppm: number;
  min_lifetime_blocks: number;
  cltv_expiry_delta: number;
  valid_until: string;
}

export interface Lsps2GetInfoParams {
  version: number;
  client_node_id: string;
}

export interface Lsps2GetInfoResponse {
  opening_fee_params_menu: Lsps2OpeningFeeParams[];
  min_payment_size_msat: string;
  max_payment_size_msat: string;
}

export interface Lsps2BuyParams {
  version: number;
  opening_fee_params: Lsps2OpeningFeeParams;
  payment_hash: string;
  client_node_id: string;
}

export interface Lsps2BuyResponse {
  jit_channel_scid: string;
  lsp_node_id: string;
  client_node_id: string;
  payment_size_msat: string;
  cltv_expiry_delta: number;
}

// --- LSPS1 over REST (bLIP-51 HTTP binding, as used by real mainnet LSPs: Megalith, Olympus/ZEUS) ---
// These LSPs expose LSPS1 as a plain REST API (path-per-method, no JSON-RPC envelope), with sat
// amounts as strings. get_info returns `uris` (read live for the peer connection) and only
// max_channel_expiry_blocks (no min). Not all fields are returned by every LSP — hence the optionals.
export interface Lsps1RestGetInfoResponse {
  min_channel_balance_sat: string;
  max_channel_balance_sat: string;
  min_initial_lsp_balance_sat?: string;
  max_initial_lsp_balance_sat?: string;
  min_initial_client_balance_sat?: string;
  max_initial_client_balance_sat?: string;
  max_channel_expiry_blocks: number;
  min_required_channel_confirmations?: number;
  min_funding_confirms_within_blocks?: number;
  supports_zero_channel_reserve?: boolean;
  uris: string[];
}

export interface Lsps1RestCreateOrderRequest {
  lsp_balance_sat: string;
  client_balance_sat: string;
  required_channel_confirmations: number;
  funding_confirms_within_blocks: number;
  channel_expiry_blocks: number;
  token?: string;
  refund_onchain_address?: string;
  announce_channel: boolean;
  public_key: string; // the CLIENT's node pubkey (channel destination) — bLIP-51 uses `public_key`
}

export interface Lsps1RestOrderResponse {
  order_id: string;
  order_state: "CREATED" | "COMPLETED" | "FAILED" | string;
  lsp_balance_sat?: string;
  client_balance_sat?: string;
  payment?: {
    bolt11?: { state?: string; expires_at?: string; fee_total_sat?: string; invoice?: string };
    onchain?: { state?: string; address?: string; min_onchain_payment_confirmations?: number; min_fee_for_0conf?: number };
  };
  channel?: unknown | null;
}

// Known mainnet LSPS1-over-REST providers. Reference data the APP uses to build an LspProvider;
// the SDK still takes injected config (no hardcoded endpoints inside the library behaviour).
export interface Lsps1RestProvider {
  name: string;
  restBaseUrl: string;
  supportsZeroConf: boolean; // 0-conf (instant) channels over LSPS1
  // Channel-size bounds + lease/cost character. Live-verified against each LSP's get_info 2026-07-04
  // (reference values for informed provider selection + client-side range guard; the SDK still clamps
  // against the LSP's live get_info at order time, so a slightly-stale hint here is harmless).
  minChannelSat: number;
  maxChannelSat: number;
  maxLeaseBlocks: number; // LSP's max_channel_expiry_blocks — the longest lease it will grant
  leaseMonthsApprox: number;
  costNote: string; // one-line cost/lease summary for the picker help text
}
export const LSPS1_REST_PROVIDERS: Record<string, Lsps1RestProvider> = {
  megalith: {
    name: "Megalith",
    restBaseUrl: "https://megalithic.me/api/lsps1/v1",
    supportsZeroConf: true,
    minChannelSat: 150_000,
    maxChannelSat: 16_000_000,
    maxLeaseBlocks: 13_140, // ~3 months
    leaseMonthsApprox: 3,
    costNote: "Cheaper upfront + instant (0-conf), ~3-month lease",
  },
  olympus: {
    name: "Olympus (ZEUS)",
    restBaseUrl: "https://lsps1.lnolymp.us/api/v1",
    supportsZeroConf: false,
    minChannelSat: 100_000,
    maxChannelSat: 10_000_000,
    maxLeaseBlocks: 52_560, // ~12 months
    leaseMonthsApprox: 12,
    costNote: "Pricier upfront but ~12-month lease (cheaper per month), 3-conf",
  },
};

// LSPS1 Inbound capacity interfaces
export interface Lsps1GetInfoResponse {
  min_channel_balance_sat: string;
  max_channel_balance_sat: string;
  min_initial_client_balance_sat: string;
  max_initial_client_balance_sat: string;
  min_channel_expiry_blocks: number;
  max_channel_expiry_blocks: number;
}

export interface Lsps1CreateOrderParams {
  lsp_balance_sat: string;
  client_balance_sat: string;
  client_node_id: string;
  channel_expiry_blocks: number;
  announce_channel: boolean;
}

export interface Lsps1CreateOrderResponse {
  order_id: string;
  lsp_balance_sat: string;
  client_balance_sat: string;
  payment_value_msat?: string;
  payment_addr?: string;
  // Flat invoice field as returned by the regtest dev LSP. Spec-compliant LSPs
  // (bLIP-51) instead nest it at `payment.bolt11.invoice` — see `payment` below.
  // Consumers should read whichever is present.
  invoice?: string;
  // Spec (bLIP-51) shape: the BOLT11 to pay lives under payment.bolt11.invoice.
  payment?: {
    bolt11?: {
      invoice?: string;
    };
  };
}

// Append the desired peer target (host:port) to a WebSocket bridge base URL. The multi-target
// ws-bridge reads ?target= and connects there; an old single-target websockify ignores the query,
// so the default-peer path stays backward-compatible during rollout.
export function bridgeTargetUrl(base: string, host: string, port: number): string {
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}target=${encodeURIComponent(`${host}:${port}`)}`;
}

export * from "./v4v-utils";
export * from "./nwc-schema";

