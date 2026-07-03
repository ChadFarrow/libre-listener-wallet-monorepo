import type {
  Lsps2GetVersionsResponse,
  Lsps2GetInfoResponse,
  Lsps2BuyResponse,
  Lsps2OpeningFeeParams,
} from "@libre/shared";

export interface LspBackend {
  lspNodeId(): Promise<string>;
  // The opening-fee menu advertised by lsps2.get_info.
  getFeeMenu(): Lsps2OpeningFeeParams[];
  // Registers a JIT for this client+payment and opens the (instant zero-conf) channel, returning
  // the intercept scid the client must advertise and the fee params that apply.
  buy(clientNodeId: string, paymentHash: string): Promise<{ scid: string; feeParams: Lsps2OpeningFeeParams }>;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: any;
}

const ok = (id: string | number, result: object) => ({ jsonrpc: "2.0" as const, id, result });
const err = (id: string | number, code: number, message: string) => ({ jsonrpc: "2.0" as const, id, error: { code, message } });
const isHexPubkey = (s: unknown): s is string => typeof s === "string" && /^[0-9a-fA-F]{66}$/.test(s);
const isHash = (s: unknown): s is string => typeof s === "string" && /^[0-9a-fA-F]{64}$/.test(s);

export async function handleJsonRpc(req: JsonRpcRequest, backend: LspBackend): Promise<object> {
  const { id, method, params } = req;
  switch (method) {
    case "lsps2.get_versions": {
      const result: Lsps2GetVersionsResponse = { versions: [1] };
      return ok(id, result);
    }
    case "lsps2.get_info": {
      const result: Lsps2GetInfoResponse = {
        opening_fee_params_menu: backend.getFeeMenu(),
        min_payment_size_msat: "1000",
        max_payment_size_msat: "100000000",
      };
      return ok(id, result);
    }
    case "lsps2.buy": {
      const clientNodeId = params?.client_node_id;
      if (!isHexPubkey(clientNodeId)) return err(id, -32602, "Invalid params: client_node_id must be a 66-char hex pubkey");
      const paymentHash = params?.payment_hash;
      if (!isHash(paymentHash)) return err(id, -32602, "Invalid params: payment_hash must be a 64-char hex string");
      const lspNodeId = await backend.lspNodeId();
      const { scid, feeParams } = await backend.buy(clientNodeId, paymentHash);
      const result: Lsps2BuyResponse = {
        jit_channel_scid: scid,
        lsp_node_id: lspNodeId,
        client_node_id: clientNodeId,
        payment_size_msat: typeof params?.payment_size_msat === "string" ? params.payment_size_msat : "0",
        cltv_expiry_delta: feeParams.cltv_expiry_delta,
      };
      return ok(id, result);
    }
    default:
      return err(id, -32601, "Method not found");
  }
}
