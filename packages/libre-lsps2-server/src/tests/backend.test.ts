import { describe, it, expect, vi } from "vitest";
import { LndLspBackend } from "../backend";

const CLIENT = "03clientbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("LndLspBackend.openAndConfirm", () => {
  it("opens a channel (void), mines, then finds scid by pubkey — in that order", async () => {
    const callOrder: string[] = [];

    const lnd = {
      getInfo: vi.fn(async () => ({ identity_pubkey: "02lsp" })),
      openChannel: vi.fn(async () => {
        callOrder.push("openChannel");
        // openChannel returns void
      }),
      findChannelScid: vi.fn(async () => {
        callOrder.push("findChannelScid");
        return "678";
      }),
    } as any;
    const bitcoind = {
      mineBlocks: vi.fn(async () => {
        callOrder.push("mineBlocks");
      }),
    } as any;

    const be = new LndLspBackend({ lnd, bitcoind, capacitySat: 1000000, pushSat: 200000, confirmBlocks: 3 });

    expect(await be.lspNodeId()).toBe("02lsp");
    const out = await be.openAndConfirm(CLIENT);

    // openChannel receives the right args
    expect(lnd.openChannel).toHaveBeenCalledWith({
      nodePubkeyHex: CLIENT,
      localFundingSat: 1000000,
      pushSat: 200000,
    });

    // mineBlocks called with confirmBlocks
    expect(bitcoind.mineBlocks).toHaveBeenCalledWith(3);

    // findChannelScid called with pubkey only (no fundingTxid/outputIndex)
    expect(lnd.findChannelScid).toHaveBeenCalledWith({ nodePubkeyHex: CLIENT });

    // Order: open → mine → findScid
    expect(callOrder).toEqual(["openChannel", "mineBlocks", "findChannelScid"]);

    expect(out).toEqual({ scid: "678" });
  });
});
