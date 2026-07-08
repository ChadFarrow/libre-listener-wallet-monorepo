// The single strict integer parser behind every user- or client-supplied sat
// amount (form fields, NWC wire params, spending caps). Bare parseInt/Number is
// unsafe at these boundaries: "1,000" → 1 (parseInt), "" → 0 (Number), "1e9" → 1
// (parseInt), NaN coerces to 0 in `|| 0` chains — each of which silently turns a
// typo into a wrong spend or an unlimited cap. Callers layer their own zero/blank
// semantics on top; this core only answers "is this exactly one safe integer?".

/**
 * Strictly parse a base-10 integer string. Accepts ONLY a digit string whose
 * canonical decimal form round-trips the trimmed input, so lossy or ambiguous
 * forms — "", "1,000", "1e9", "-5", "1.5", "007", "0x10", values past
 * Number.MAX_SAFE_INTEGER — all return null instead of a silently-wrong number.
 */
export function parseStrictInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || String(value) !== trimmed) return null;
  return value;
}
