// Pure opening-fee math for the JIT interceptor. No lnd/network deps so it's unit-testable.

const U64_MAX = (1n << 64n) - 1n;

export interface OpeningFee {
  minFeeMsat: bigint;
  proportionalPpm: number;
}

// LSPS2 opening fee = max(min_fee_msat, ceil(payment_msat * proportional_ppm / 1_000_000)).
export function computeOpeningFeeMsat(paymentMsat: bigint, p: OpeningFee): bigint {
  const ppm = BigInt(p.proportionalPpm);
  // ceil division on bigints
  const proportional = (paymentMsat * ppm + 999_999n) / 1_000_000n;
  return proportional > p.minFeeMsat ? proportional : p.minFeeMsat;
}

// Amount to forward to the client after skimming the opening fee. Throws when the fee would
// consume the whole payment (the interceptor must FAIL the HTLC in that case).
export function forwardedAmountMsat(paymentMsat: bigint, feeMsat: bigint): bigint {
  if (feeMsat >= paymentMsat) {
    throw new Error(`opening fee ${feeMsat} msat >= payment ${paymentMsat} msat — cannot forward`);
  }
  return paymentMsat - feeMsat;
}

// lnd returns short-channel-ids / aliases as decimal uint64 strings. Parse to bigint with strict
// validation (digits only, within uint64 range) so a bad value can't be encoded into a route hint.
export function parseScidToBigint(decimal: string): bigint {
  if (!/^\d+$/.test(decimal)) {
    throw new Error(`invalid scid ${JSON.stringify(decimal)} — expected a decimal uint64 string`);
  }
  const v = BigInt(decimal);
  if (v > U64_MAX) throw new Error(`scid ${decimal} exceeds uint64 max`);
  return v;
}
