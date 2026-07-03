// Decides what to do with an intercepted HTLC: skim the one-time LSPS2 opening fee from the first
// payment to a promised JIT scid, otherwise pass through. Kept separate from the gRPC transport so
// it's unit-testable against a real (in-memory) JitStore with no lnd.
import type { InterceptRequest, InterceptDecision } from "./intercept-types";
import type { JitStore } from "./jit-store";
import { computeOpeningFeeMsat } from "./fee";

export function decideIntercept(req: InterceptRequest, store: JitStore): InterceptDecision {
  const entry = store.byScid(req.outgoingRequestedChanId);
  // Not a JIT scid we promised → let lnd forward it normally.
  if (!entry) return { action: "resume" };
  // Only skim the exact payment this JIT was registered for; anything else passes through.
  if (entry.paymentHash !== req.paymentHash.toLowerCase()) return { action: "resume" };
  // The opening fee is one-time; later HTLCs over the channel forward at full value.
  if (entry.feeSkimmed) return { action: "resume" };

  const fee = computeOpeningFeeMsat(req.outgoingAmountMsat, entry.feeParams);
  if (fee >= req.outgoingAmountMsat) return { action: "fail" };

  store.markSkimmed(entry.scid);
  return { action: "resume_modified", outAmountMsat: req.outgoingAmountMsat - fee };
}
