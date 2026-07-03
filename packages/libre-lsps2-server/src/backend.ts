import type { Lsps2OpeningFeeParams } from "@libre/shared";
import type { LspBackend } from "./jsonrpc";
import type { LndRestClient } from "./lnd-client";
import type { JitStore } from "./jit-store";
import type { InterceptRequest, InterceptDecision } from "./intercept-types";
import { decideIntercept } from "./intercept";

export class LndLspBackend implements LspBackend {
  constructor(
    private deps: {
      lnd: LndRestClient;
      store: JitStore;
      capacitySat: number;
      pushSat: number;
      feeParams: Lsps2OpeningFeeParams;
    }
  ) {}

  async lspNodeId(): Promise<string> {
    return (await this.deps.lnd.getInfo()).identity_pubkey;
  }

  getFeeMenu(): Lsps2OpeningFeeParams[] {
    return [this.deps.feeParams];
  }

  // Open an instant zero-conf channel now (no mining), read lnd's alias for it, and register the
  // JIT so the interceptor can skim the opening fee from the first payment to that alias.
  async buy(clientNodeId: string, paymentHash: string): Promise<{ scid: string; feeParams: Lsps2OpeningFeeParams }> {
    const { lnd, store, capacitySat, pushSat, feeParams } = this.deps;
    await lnd.openZeroConfChannel({ nodePubkeyHex: clientNodeId, localFundingSat: capacitySat, pushSat });
    const scid = await lnd.findZeroConfAlias({ nodePubkeyHex: clientNodeId });
    store.register({
      clientNodeId,
      paymentHash,
      scid,
      feeParams: { minFeeMsat: BigInt(feeParams.min_fee_msat), proportionalPpm: feeParams.proportional_fee_ppm },
    });
    return { scid, feeParams };
  }

  // Wired to the gRPC HTLC interceptor: skim the one-time opening fee, otherwise pass through.
  async handleIntercept(req: InterceptRequest): Promise<InterceptDecision> {
    return decideIntercept(req, this.deps.store);
  }
}
