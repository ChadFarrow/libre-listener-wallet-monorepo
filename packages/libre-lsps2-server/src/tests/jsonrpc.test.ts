import { describe, it, expect, vi } from "vitest";
import { handleJsonRpc, LspBackend } from "../jsonrpc";
import type { Lsps2OpeningFeeParams } from "@libre/shared";

const lnPub = "02".padEnd(66, "a");
const client = "03".padEnd(66, "b");
const HASH = "a".repeat(64);

const DEV_FEE: Lsps2OpeningFeeParams = {
  opening_fee_params_id: "dev",
  min_fee_msat: "250000",
  proportional_fee_ppm: 1000,
  min_lifetime_blocks: 2016,
  cltv_expiry_delta: 144,
  valid_until: "2100-01-01T00:00:00Z",
};

function backend(over: Partial<LspBackend> = {}): LspBackend {
  return {
    lspNodeId: vi.fn(async () => lnPub),
    getFeeMenu: vi.fn(() => [DEV_FEE]),
    buy: vi.fn(async (_c: string, _h: string) => ({ scid: "112233445566", feeParams: DEV_FEE })),
    ...over,
  };
}

describe("handleJsonRpc", () => {
  it("get_versions returns [1]", async () => {
    const r: any = await handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "lsps2.get_versions" }, backend());
    expect(r).toEqual({ jsonrpc: "2.0", id: 1, result: { versions: [1] } });
  });

  it("get_info returns the backend's (non-zero) fee menu + payment bounds", async () => {
    const r: any = await handleJsonRpc({ jsonrpc: "2.0", id: 2, method: "lsps2.get_info", params: { version: 1, client_node_id: client } }, backend());
    expect(r.result.min_payment_size_msat).toBe("1000");
    expect(r.result.max_payment_size_msat).toBe("100000000");
    const m = r.result.opening_fee_params_menu[0];
    expect(m.min_fee_msat).toBe("250000");
    expect(m.proportional_fee_ppm).toBe(1000);
    expect(m.cltv_expiry_delta).toBe(144);
  });

  it("buy registers the JIT via the backend and returns the intercept scid", async () => {
    const be = backend();
    const r: any = await handleJsonRpc(
      { jsonrpc: "2.0", id: 3, method: "lsps2.buy", params: { version: 1, client_node_id: client, payment_hash: HASH, opening_fee_params: { opening_fee_params_id: "dev" } } },
      be
    );
    expect(be.buy).toHaveBeenCalledWith(client, HASH);
    expect(r.result).toMatchObject({ jit_channel_scid: "112233445566", lsp_node_id: lnPub, client_node_id: client, cltv_expiry_delta: 144 });
  });

  it("buy with a non-66-hex client_node_id errors without touching the backend", async () => {
    const be = backend();
    const r: any = await handleJsonRpc({ jsonrpc: "2.0", id: 4, method: "lsps2.buy", params: { client_node_id: "nope", payment_hash: HASH } }, be);
    expect(r.error.code).toBe(-32602);
    expect(be.buy).not.toHaveBeenCalled();
  });

  it("buy with a missing/invalid payment_hash errors without touching the backend", async () => {
    const be = backend();
    const r: any = await handleJsonRpc({ jsonrpc: "2.0", id: 5, method: "lsps2.buy", params: { client_node_id: client } }, be);
    expect(r.error.code).toBe(-32602);
    expect(be.buy).not.toHaveBeenCalled();
  });

  it("unknown method → -32601", async () => {
    const r: any = await handleJsonRpc({ jsonrpc: "2.0", id: 6, method: "lsps2.frobnicate" }, backend());
    expect(r.error.code).toBe(-32601);
  });
});
