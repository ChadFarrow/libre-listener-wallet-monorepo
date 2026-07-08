// Strict parse for the NWC daily spending-limit field. `Number(value) || 0` is
// unsafe: blank / "abc" / NaN all collapse to 0, and 0 means UNLIMITED — silently
// minting an unlimited-spend pairing. The integer core lives in @libre/shared
// (`parseStrictInt`); 0 is allowed only when typed on purpose (and flagged as
// unlimited).
import { parseStrictInt } from "@libre/shared";

export type ParsedNwcLimit =
  | { ok: true; value: number; unlimited: boolean }
  | { ok: false; error: string };

export function parseNwcLimit(raw: string): ParsedNwcLimit {
  const value = parseStrictInt(raw);
  if (value === null) {
    return { ok: false, error: "Enter a spending limit in sats (use 0 for an explicitly unlimited pairing)." };
  }
  return { ok: true, value, unlimited: value === 0 };
}
