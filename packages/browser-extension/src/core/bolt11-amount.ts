// Minimal BOLT11 amount decoder — just enough to read the invoice amount for the per-origin
// spending-cap check in the background gate (which has no LDK/WASM). The authoritative payment
// still goes through the offscreen LDK node; this only needs the amount, which lives in the
// human-readable prefix, so no bech32/crypto is required.
//
// hrp = "ln" + currency + optional(amount = digits + optional multiplier [m|u|n|p]).
// Multiplier is a fraction of 1 BTC: m=1e-3, u=1e-6, n=1e-9, p=1e-12.

const UNIT_MSAT_PER_BTC = 100_000_000_000n; // 1 BTC = 1e8 sat = 1e11 msat

// msat per one unit of "<digits><multiplier>". p (pico) can be a tenth of a msat, so we track
// msat as a rational (numerator/denominator) to stay exact, then convert to sats.
const MULT: Record<string, { num: bigint; den: bigint }> = {
  "": { num: UNIT_MSAT_PER_BTC, den: 1n },
  m: { num: UNIT_MSAT_PER_BTC / 1_000n, den: 1n },
  u: { num: UNIT_MSAT_PER_BTC / 1_000_000n, den: 1n },
  n: { num: UNIT_MSAT_PER_BTC / 1_000_000_000n, den: 1n },
  p: { num: UNIT_MSAT_PER_BTC, den: 1_000_000_000_000n }, // 1e11 / 1e12 = 0.1 msat per unit
};

// Returns the invoice amount in sats, or null for a zero-amount ("any amount") invoice, or
// throws for a malformed BOLT11 hrp.
export function invoiceAmountSats(bolt11: string): number | null {
  const s = bolt11.trim().toLowerCase();
  if (!s.startsWith("ln")) throw new Error("Not a BOLT11 invoice");
  const sep = s.lastIndexOf("1");
  if (sep < 0) throw new Error("Malformed BOLT11 (no separator)");
  const hrp = s.slice(0, sep);
  const afterLn = hrp.slice(2);
  const currency = ["bcrt", "tbs", "bc", "tb", "sb"].find((c) => afterLn.startsWith(c));
  if (currency === undefined) throw new Error("Unknown BOLT11 currency prefix");
  const amountPart = afterLn.slice(currency.length);
  if (amountPart === "") return null; // zero-amount invoice
  const m = /^(\d+)([munp]?)$/.exec(amountPart);
  if (!m) throw new Error("Malformed BOLT11 amount");
  const digits = BigInt(m[1]);
  const mult = MULT[m[2]];
  // msat = digits * num / den ; sats = msat / 1000, rounded to nearest.
  const msatNum = digits * mult.num;
  const satsNum = msatNum; // /den/1000 below
  const den = mult.den * 1000n;
  // rounded division
  const sats = (satsNum + den / 2n) / den;
  return Number(sats);
}
