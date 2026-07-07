// Strict sat-amount parsing for user-entered amount fields. Bare parseInt is unsafe:
// "1,000" → 1 (sends 1 sat as a "success"), "" / garbage → NaN flows into the SDK.
// A valid amount must be a positive integer that round-trips its own decimal string.

export type ParsedAmount =
  | { ok: true; value: number }
  | { ok: false; error: string };

/**
 * Parse a sats amount from raw input. Accepts ONLY a positive integer whose
 * canonical decimal form equals the trimmed input (so "1,000", "1.5", "", "abc",
 * "-5", " 10 " with junk are all rejected). Returns { ok, value } or { ok, error }.
 */
export function parsePositiveIntSats(raw: string): ParsedAmount {
  const trimmed = raw.trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) {
    return { ok: false, error: "Enter a whole number of sats greater than 0." };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0 || String(value) !== trimmed) {
    return { ok: false, error: "Enter a whole number of sats greater than 0." };
  }
  return { ok: true, value };
}
