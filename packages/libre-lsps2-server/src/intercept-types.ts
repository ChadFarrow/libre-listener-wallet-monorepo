// Transport-neutral shapes for the lnd HTLC interceptor, shared by the decision logic
// (intercept.ts) and the gRPC client (lnd-grpc-client.ts) so the decision stays testable
// without pulling in grpc.

export interface InterceptRequest {
  // Identifies the incoming HTLC to lnd; echoed back verbatim in the response.
  incomingCircuitKey: { chanId: string; htlcIndex: string };
  // The scid the onion asked lnd to forward over — for a JIT hint this is our promised alias.
  outgoingRequestedChanId: string; // decimal uint64
  paymentHash: string; // hex, lowercased
  outgoingAmountMsat: bigint; // amount lnd would forward to the client before any skim
}

export type InterceptDecision =
  | { action: "resume" } // forward unchanged (not ours, wrong hash, or already skimmed)
  | { action: "resume_modified"; outAmountMsat: bigint } // forward less — the one-time opening-fee skim
  | { action: "fail" }; // reject (fee would consume the whole payment)
