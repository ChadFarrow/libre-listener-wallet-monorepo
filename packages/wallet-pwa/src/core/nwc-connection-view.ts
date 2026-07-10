import type { BudgetRenewal, NwcMethod } from "@libre/shared";

// Pure view-model layer over the SDK's stored NwcConnection: strips the pairing secret
// (it must NEVER leave the controller) and formats the fields the connections list +
// detail screen render. Kept DOM-free so the secret-omission is pinned by unit tests.

export interface NwcConnectionView {
  name: string;
  clientPubkey: string;
  relayUrl: string;
  spendingLimitSats: number;
  spentThisPeriodSats: number;
  budgetRenewal?: BudgetRenewal;
  maxAmountSats?: number;
  allowedMethods?: NwcMethod[];
  expiresAt?: number;
  createdAt?: number;
  enabled?: boolean;
}

// Input is the SDK's full stored connection; typed loosely so older stored shapes
// (missing optional fields) sanitize cleanly.
export function sanitizeConnection(c: {
  name: string;
  clientPubkey: string;
  relayUrl: string;
  spendingLimitSats?: number;
  spentTodaySats?: number;
  budgetRenewal?: BudgetRenewal;
  maxAmountSats?: number;
  allowedMethods?: NwcMethod[];
  expiresAt?: number;
  createdAt?: number;
  enabled?: boolean;
}): NwcConnectionView {
  return {
    name: c.name,
    clientPubkey: c.clientPubkey,
    relayUrl: c.relayUrl,
    spendingLimitSats: c.spendingLimitSats ?? 0,
    spentThisPeriodSats: c.spentTodaySats ?? 0,
    budgetRenewal: c.budgetRenewal,
    maxAmountSats: c.maxAmountSats,
    allowedMethods: c.allowedMethods,
    expiresAt: c.expiresAt,
    createdAt: c.createdAt,
    enabled: c.enabled,
  };
}

const RENEWAL_UNIT: Record<string, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

const fmt = new Intl.NumberFormat("en-US");

// "10,000 sats / day" | "10,000 sats total" (never renews) | "Unlimited".
// undefined renewal = the legacy daily window (matches the SDK's budget enforcement).
export function limitLabel(spendingLimitSats: number, renewal: BudgetRenewal | undefined): string {
  if (!spendingLimitSats) return "Unlimited";
  if (renewal === "never") return `${fmt.format(spendingLimitSats)} sats total`;
  const unit = RENEWAL_UNIT[renewal ?? "daily"] ?? "day";
  return `${fmt.format(spendingLimitSats)} sats / ${unit}`;
}

export function expiryLabel(expiresAt: number | undefined, now: number): string {
  if (!expiresAt) return "Never";
  if (expiresAt <= now) return "Expired";
  return new Date(expiresAt).toISOString().slice(0, 10);
}
