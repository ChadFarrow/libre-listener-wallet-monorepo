import type {
  Lsps2GetVersionsResponse,
  Lsps2GetInfoResponse,
  Lsps2BuyResponse,
} from "@libre/shared";

export interface LspBackend {
  lspNodeId(): Promise<string>;
  openAndConfirm(clientNodeId: string): Promise<{ scid: string }>;
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

export async function handleJsonRpc(req: JsonRpcRequest, backend: LspBackend): Promise<object> {
  const { id, method, params } = req;
  switch (method) {
    case "lsps2.get_versions": {
      const result: Lsps2GetVersionsResponse = { versions: [1] };
      return ok(id, result);
    }
    case "lsps2.get_info": {
      const result: Lsps2GetInfoResponse = {
        opening_fee_params_menu: [
          {
            opening_fee_params_id: "dev",
            min_fee_msat: "0",
            proportional_fee_ppm: 0,
            min_lifetime_blocks: 2016,
            cltv_expiry_delta: 144,
            valid_until: new Date(Date.now() + 3600_000).toISOString(),
          },
        ],
        min_payment_size_msat: "1000",
        max_payment_size_msat: "100000000",
      };
      return ok(id, result);
    }
    case "lsps2.buy": {
      const clientNodeId = params?.client_node_id;
      if (!isHexPubkey(clientNodeId)) return err(id, -32602, "Invalid params: client_node_id must be a 66-char hex pubkey");
      const lspNodeId = await backend.lspNodeId();
      const { scid } = await backend.openAndConfirm(clientNodeId);
      const result: Lsps2BuyResponse = {
        jit_channel_scid: scid,
        lsp_node_id: lspNodeId,
        client_node_id: clientNodeId,
        payment_size_msat: typeof params?.payment_size_msat === "string" ? params.payment_size_msat : "0",
        cltv_expiry_delta: 144,
      };
      return ok(id, result);
    }
    default:
      return err(id, -32601, "Method not found");
  }
}
