// Parses the approval dialog's daily-spending-cap field.
//
// SECURITY: `spendingLimitSats: 0` means UNLIMITED in the permission store. A naive
// `Number(field.value)` fails open — `Number("") === 0` and `Number("10,000") === NaN` (which
// prior code coerced to 0) both silently grant an unlimited cap. So the number field is parsed
// strictly here and must be a positive integer; "unlimited" is only ever expressed through the
// dialog's explicit checkbox, never by a blank or unparseable value.

export type CapInput = { ok: true; sats: number } | { ok: false };

export function parseCapInput(raw: string): CapInput {
  const s = (raw ?? "").trim();
  // Plain non-negative integer only — no exponent, decimal, sign, or thousands separators.
  if (!/^\d+$/.test(s)) return { ok: false };
  const sats = Number(s);
  if (!Number.isSafeInteger(sats) || sats <= 0) return { ok: false };
  return { ok: true, sats };
}
