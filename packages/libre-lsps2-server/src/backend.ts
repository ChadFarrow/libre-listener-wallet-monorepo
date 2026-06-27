import type { LspBackend } from "./jsonrpc";
import type { LndRestClient } from "./lnd-client";
import type { BitcoindClient } from "./bitcoind-client";

export class LndLspBackend implements LspBackend {
  constructor(
    private deps: { lnd: LndRestClient; bitcoind: BitcoindClient; capacitySat: number; pushSat: number; confirmBlocks: number }
  ) {}

  async lspNodeId(): Promise<string> {
    return (await this.deps.lnd.getInfo()).identity_pubkey;
  }

  async openAndConfirm(clientNodeId: string): Promise<{ scid: string }> {
    const { lnd, bitcoind, capacitySat, pushSat, confirmBlocks } = this.deps;
    await lnd.openChannel({ nodePubkeyHex: clientNodeId, localFundingSat: capacitySat, pushSat });
    await bitcoind.mineBlocks(confirmBlocks);
    const scid = await lnd.findChannelScid({ nodePubkeyHex: clientNodeId });
    return { scid };
  }
}
