// Pure helpers for the NWC "create pairing" form: parse the advanced-control
// inputs (budget renewal, per-payment cap, method allowlist, expiry) into the
// shape `wallet.nwc.createConnection` expects. Kept side-effect-free so the
// parsing/validation is unit-testable without the DOM, and shared by the PWA
// create form and the browser-extension popup.
import type { BudgetRenewal, NwcMethod } from "./nwc-schema";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validate a budget-renewal string from the <select>. */
export function parseBudgetRenewal(raw: string): BudgetRenewal {
  const allowed: BudgetRenewal[] = ["never", "daily", "weekly", "monthly", "yearly"];
  return (allowed as string[]).includes(raw) ? (raw as BudgetRenewal) : "daily";
}

/**
 * Parse the optional per-payment cap. Blank = no cap (undefined). A non-blank
 * value must be a positive integer — a garbage entry is an error, never a
 * silent "no cap" (which would be a security footgun for a spend limit).
 */
export function parseMaxAmount(raw: string): ParseResult<number | undefined> {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: "Max per-payment must be a whole number of sats (or blank for no cap)." };
  const n = parseInt(trimmed, 10);
  if (n <= 0) return { ok: false, error: "Max per-payment must be greater than 0 (leave blank for no cap)." };
  return { ok: true, value: n };
}

/**
 * Build the method allowlist from the per-method checkbox states. `undefined`
 * (all methods) is returned only when every grantable method is checked, so the
 * connection keeps the permissive legacy shape; otherwise the exact allowed set
 * is returned. `get_info` is always available and is never part of the set.
 */
export function buildAllowedMethods(checked: Record<NwcMethod, boolean>): NwcMethod[] | undefined {
  const all: NwcMethod[] = ["get_balance", "make_invoice", "pay_invoice", "pay_keysend"];
  const selected = all.filter((m) => checked[m]);
  return selected.length === all.length ? undefined : selected;
}

/**
 * Convert an expiry-duration choice (in days; 0 = never) into an absolute
 * epoch-ms timestamp, or undefined for "never". `now` is injected for testing.
 */
export function expiryFromDays(days: number, now: number): number | undefined {
  if (!Number.isFinite(days) || days <= 0) return undefined;
  return now + Math.round(days * 24 * 60 * 60 * 1000);
}

/** Human-readable summary of a renewal period for the connections list. */
export function renewalLabel(renewal: BudgetRenewal | undefined): string {
  switch (renewal ?? "daily") {
    case "never": return "one-time";
    case "daily": return "daily";
    case "weekly": return "weekly";
    case "monthly": return "monthly";
    case "yearly": return "yearly";
  }
}
