import { parseCapInput } from "./cap-input";

// Pure decisions for persisting a WebLN grant in the background service worker.
//
// SECURITY: `spendingLimitSats: 0` means UNLIMITED in the PermissionStore. The old grant sites did
// `Number(x) || 0`, so a blank ("") or unparseable ("10,000" → NaN) value silently became 0 — an
// accidental unlimited grant. "Unlimited" must be expressible ONLY through the approval dialog's
// explicit "No daily limit" checkbox, which sends a literal 0. Everything else must be a positive
// integer; anything unparseable is REFUSED (throws) rather than failing open to unlimited.
export function resolveGrantLimitSats(raw: unknown): number {
  const s = String(raw ?? "").trim();
  if (s === "0") return 0; // explicit, deliberate unlimited signal
  const parsed = parseCapInput(s);
  if (!parsed.ok) {
    throw new Error("Invalid spending limit: enter a whole number of sats greater than 0, or 0 for no limit.");
  }
  return parsed.sats;
}

// The authoritative origin for a grant is the one recorded when the approval prompt was created
// (the pending record), NOT the origin echoed back in the decision message — a forged
// APPROVAL_DECISION could spoof `msg.origin`. Only fall back to the message origin when no pending
// record survives (the MV3 SW was reaped mid-prompt and the pending map was lost).
export function resolveGrantOrigin(
  pendingOrigin: string | undefined,
  msgOrigin: string | undefined
): string | undefined {
  return pendingOrigin ?? msgOrigin;
}
