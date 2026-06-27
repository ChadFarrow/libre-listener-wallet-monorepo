import { describe, it, expect, vi } from "vitest";
import { handleJsonRpc, LspBackend } from "../jsonrpc";

const lnPub = "02".padEnd(66, "a");
const client = "03".padEnd(66, "b");

function backend(over: Partial<LspBackend> = {}): LspBackend {
  return {
    lspNodeId: vi.fn(async () => lnPub),
    openAndConfirm: vi.fn(async (_c: string) => ({ scid: "111x1x1" })),
    ...over,
  };
}

describe("handleJsonRpc", () => {
  it("get_versions returns [1]", async () => {
    const r: any = await handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "lsps2.get_versions" }, backend());
    expect(r).toEqual({ jsonrpc: "2.0", id: 1, result: { versions: [1] } });
  });

  it("get_info returns a zero-fee menu + payment bounds", async () => {
    const r: any = await handleJsonRpc({ jsonrpc: "2.0", id: 2, method: "lsps2.get_info", params: { version: 1, client_node_id: client } }, backend());
    expect(r.result.min_payment_size_msat).toBe("1000");
    expect(r.result.max_payment_size_msat).toBe("100000000");
    const m = r.result.opening_fee_params_menu[0];
    expect(m.min_fee_msat).toBe("0");
    expect(m.proportional_fee_ppm).toBe(0);
    expect(m.cltv_expiry_delta).toBe(144);
  });

  it("buy opens+confirms a channel and returns the scid", async () => {
    const be = backend();
    const r: any = await handleJsonRpc(
      { jsonrpc: "2.0", id: 3, method: "lsps2.buy", params: { version: 1, client_node_id: client, opening_fee_params: { opening_fee_params_id: "dev" } } },
      be
    );
    expect(be.openAndConfirm).toHaveBeenCalledWith(client);
    expect(r.result).toMatchObject({ jit_channel_scid: "111x1x1", lsp_node_id: lnPub, client_node_id: client, cltv_expiry_delta: 144 });
  });

  it("buy with a non-66-hex client_node_id errors without touching the backend", async () => {
    const be = backend();
    const r: any = await handleJsonRpc({ jsonrpc: "2.0", id: 4, method: "lsps2.buy", params: { client_node_id: "nope" } }, be);
    expect(r.error.code).toBe(-32602);
    expect(be.openAndConfirm).not.toHaveBeenCalled();
  });

  it("unknown method → -32601", async () => {
    const r: any = await handleJsonRpc({ jsonrpc: "2.0", id: 5, method: "lsps2.frobnicate" }, backend());
    expect(r.error.code).toBe(-32601);
  });
});
