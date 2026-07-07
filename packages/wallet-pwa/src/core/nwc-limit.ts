// Strict parse for the NWC daily spending-limit field. `Number(value) || 0` is
// unsafe: blank / "abc" / NaN all collapse to 0, and 0 means UNLIMITED — silently
// minting an unlimited-spend pairing. Require an explicit whole number; 0 is
// allowed only when typed on purpose (and flagged as unlimited).

export type ParsedNwcLimit =
  | { ok: true; value: number; unlimited: boolean }
  | { ok: false; error: string };

export function parseNwcLimit(raw: string): ParsedNwcLimit {
  const trimmed = raw.trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) {
    return { ok: false, error: "Enter a spending limit in sats (use 0 for an explicitly unlimited pairing)." };
  }
  const value = parseInt(trimmed, 10);
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, error: "Enter a spending limit in sats (use 0 for an explicitly unlimited pairing)." };
  }
  return { ok: true, value, unlimited: value === 0 };
}
