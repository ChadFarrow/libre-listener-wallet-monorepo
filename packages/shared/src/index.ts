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
  payment_value_msat: string;
  payment_addr: string;
  invoice: string;
}

export * from "./v4v-utils";
export * from "./nwc-schema";

