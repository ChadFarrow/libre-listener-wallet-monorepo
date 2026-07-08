// Strict sat-amount parsing for user-entered amount fields. Bare parseInt is unsafe:
// "1,000" → 1 (sends 1 sat as a "success"), "" / garbage → NaN flows into the SDK.
// The integer core lives in @libre/shared (`parseStrictInt`); this wrapper adds the
// "must be > 0" rule and the form-field error message.
import { parseStrictInt } from "@libre/shared";

export type ParsedAmount =
  | { ok: true; value: number }
  | { ok: false; error: string };

/**
 * Parse a sats amount from raw input. Accepts ONLY a positive integer whose
 * canonical decimal form equals the trimmed input (so "1,000", "1.5", "", "abc",
 * "-5", "007" are all rejected). Returns { ok, value } or { ok, error }.
 */
export function parsePositiveIntSats(raw: string): ParsedAmount {
  const value = parseStrictInt(raw);
  if (value === null || value <= 0) {
    return { ok: false, error: "Enter a whole number of sats greater than 0." };
  }
  return { ok: true, value };
}
