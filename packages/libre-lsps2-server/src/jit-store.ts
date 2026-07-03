// In-memory registry of pending JIT channels, keyed by the intercept scid the LSP promised the
// client in lsps2.buy. Regtest dev only — no persistence; a server restart drops pending JITs.

export interface JitFeeParams {
  minFeeMsat: bigint;
  proportionalPpm: number;
}

export interface JitEntry {
  clientNodeId: string;
  paymentHash: string; // hex, lowercased
  scid: string; // decimal alias returned to the client as jit_channel_scid
  feeParams: JitFeeParams;
  feeSkimmed: boolean; // true once the one-time opening fee has been taken from a forward
  createdAt: number;
}

export class JitStore {
  private byScidMap = new Map<string, JitEntry>();

  register(e: { clientNodeId: string; paymentHash: string; scid: string; feeParams: JitFeeParams }): void {
    this.byScidMap.set(e.scid, {
      clientNodeId: e.clientNodeId,
      paymentHash: e.paymentHash.toLowerCase(),
      scid: e.scid,
      feeParams: e.feeParams,
      feeSkimmed: false,
      createdAt: Date.now(),
    });
  }

  byScid(scid: string): JitEntry | undefined {
    return this.byScidMap.get(scid);
  }

  byPaymentHash(hash: string): JitEntry | undefined {
    const h = hash.toLowerCase();
    for (const e of this.byScidMap.values()) if (e.paymentHash === h) return e;
    return undefined;
  }

  markSkimmed(scid: string): void {
    const e = this.byScidMap.get(scid);
    if (e) e.feeSkimmed = true;
  }
}
