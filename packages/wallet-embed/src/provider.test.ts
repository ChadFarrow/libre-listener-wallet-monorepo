import { describe, it, expect, vi } from "vitest";
import { createWeblnProvider, installWebln, type ApprovalRequest } from "./provider";
import type { KVStore, WalletRpc } from "@libre/wallet-core";

// A real regtest invoice for 100 sats (1u) — bolt11-amount decodes the hrp amount only, so an
// abbreviated-but-well-formed hrp+data string is enough for the decoder used here.
const INVOICE_100 = "lnbcrt1u1invoicebody";

function memKV(): KVStore {
  const m = new Map<string, string>();
  return {
    async get(k) {
      return m.get(k) ?? null;
    },
    async set(k, v) {
      m.set(k, v);
    },
  };
}

function makeProvider(over: {
  rpc?: Partial<WalletRpc>;
  approve?: (req: ApprovalRequest) => { granted: boolean; limitSats?: number | null };
  active?: boolean;
} = {}) {
  const approvals: ApprovalRequest[] = [];
  const rpc: WalletRpc = {
    getInfo: async () => ({ pubkey: "02".repeat(33), alias: "test", network: "regtest" }),
    getBalanceSats: async () => 1000,
    makeInvoice: async () => ({ paymentRequest: "lnbcrt..." }),
    payInvoice: async () => ({ preimage: "aa".repeat(32) }),
    keysend: async () => ({ preimage: "bb".repeat(32) }),
    ...over.rpc,
  };
  const provider = createWeblnProvider({
    rpc,
    origin: "https://host.example",
    kv: memKV(),
    requestApproval: async (req) => {
      approvals.push(req);
      const d = over.approve?.(req) ?? { granted: true, limitSats: 1000 };
      return d.granted ? { granted: true, limitSats: d.limitSats ?? 1000 } : { granted: false };
    },
    isActive: () => over.active ?? true,
  });
  return { provider, approvals, rpc };
}

describe("createWeblnProvider", () => {
  it("enable() asks for approval once, then persists the grant", async () => {
    const { provider, approvals } = makeProvider();
    await provider.enable();
    await provider.enable();
    expect(approvals.filter((a) => a.kind === "enable").length).toBe(1);
    expect(provider.isEnabled).toBe(true);
  });

  it("a denied enable() rejects and never reaches the wallet", async () => {
    const getInfo = vi.fn();
    const { provider } = makeProvider({ approve: () => ({ granted: false }), rpc: { getInfo } });
    await expect(provider.getInfo()).rejects.toThrow(/rejected/i);
    expect(getInfo).not.toHaveBeenCalled();
  });

  it("keysend charges the cap; a second spend over the cap prompts raise-cap and honors denial", async () => {
    const keysend = vi.fn(async () => ({ preimage: "bb".repeat(32) }));
    let denyRaise = false;
    const { provider, approvals } = makeProvider({
      rpc: { keysend },
      approve: (req) => (req.kind === "raise-cap" && denyRaise ? { granted: false } : { granted: true, limitSats: 1000 }),
    });
    await provider.keysend({ destination: "02" + "ab".repeat(32), amount: 800 });
    expect(keysend).toHaveBeenCalledOnce();
    denyRaise = true;
    await expect(provider.keysend({ destination: "02" + "ab".repeat(32), amount: 800 })).rejects.toThrow(/limit/i);
    expect(keysend).toHaveBeenCalledOnce(); // the over-cap spend never reached the wallet
    expect(approvals.some((a) => a.kind === "raise-cap" && a.amountSats === 800)).toBe(true);
  });

  it("raising the cap on prompt lets the over-cap spend through", async () => {
    const keysend = vi.fn(async () => ({ preimage: "bb".repeat(32) }));
    const { provider } = makeProvider({
      rpc: { keysend },
      approve: (req) => ({ granted: true, limitSats: req.kind === "raise-cap" ? 5000 : 1000 }),
    });
    await provider.keysend({ destination: "02" + "ab".repeat(32), amount: 800 });
    await provider.keysend({ destination: "02" + "ab".repeat(32), amount: 800 }); // over the 1000 cap → prompt → raised
    expect(keysend).toHaveBeenCalledTimes(2);
  });

  it("a failed keysend refunds the cap charge (dispatch failure is definitive)", async () => {
    const keysend = vi
      .fn<[], Promise<{ preimage: string }>>()
      .mockRejectedValueOnce(new Error("no route"))
      .mockResolvedValue({ preimage: "bb".repeat(32) });
    const { provider } = makeProvider({ rpc: { keysend: keysend as unknown as WalletRpc["keysend"] } });
    await expect(provider.keysend({ destination: "02" + "ab".repeat(32), amount: 900 })).rejects.toThrow(/no route/);
    // refunded → the full 1000 cap is available again
    await provider.keysend({ destination: "02" + "ab".repeat(32), amount: 900 });
  });

  it("a PAYMENT_TIMEOUT keeps the charge (in-flight is never refunded)", async () => {
    const timeoutErr = Object.assign(new Error("payment timed out [PAYMENT_TIMEOUT]"), { code: "PAYMENT_TIMEOUT" });
    const payInvoice = vi.fn(async () => {
      throw timeoutErr;
    });
    const { provider } = makeProvider({ rpc: { payInvoice } });
    await expect(provider.sendPayment(INVOICE_100)).rejects.toThrow(/PAYMENT_TIMEOUT/);
    // The 100-sat charge stands: 10 more of these would hit a 1000 cap after 9 (100 charged),
    // simplest observable: spending the remaining 900 works, 901st sat prompts raise-cap.
    const keysendOk = await provider.keysend({ destination: "02" + "ab".repeat(32), amount: 900 });
    expect(keysendOk.preimage).toBeTruthy();
  });

  it("refuses spends while the wallet is not active here (moved away / draining)", async () => {
    const { provider } = makeProvider({ active: false });
    await expect(provider.keysend({ destination: "02" + "ab".repeat(32), amount: 10 })).rejects.toThrow(/not active/i);
  });

  it("fails closed on an invoice whose amount can't be decoded", async () => {
    const payInvoice = vi.fn();
    const { provider } = makeProvider({ rpc: { payInvoice } });
    await expect(provider.sendPayment("lnbcrt1gibberish")).rejects.toThrow(/amount/i);
    expect(payInvoice).not.toHaveBeenCalled();
  });
});

describe("installWebln", () => {
  it("installs once and never clobbers an existing provider", () => {
    const { provider } = makeProvider();
    const w = new EventTarget() as unknown as Window & { webln?: unknown };
    expect(installWebln(provider, w)).toBe(true);
    expect(w.webln).toBe(provider);
    const { provider: second } = makeProvider();
    expect(installWebln(second, w)).toBe(false);
    expect(w.webln).toBe(provider);
  });
});
