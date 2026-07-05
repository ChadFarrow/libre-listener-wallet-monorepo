import { z } from "zod";

export const getInfoParamsSchema = z.object({}).optional();
export const getBalanceParamsSchema = z.object({}).optional();

export const makeInvoiceParamsSchema = z.object({
  amount: z.union([z.number(), z.string().transform((v) => parseInt(v, 10))]),
  description: z.string().optional(),
  description_hash: z.string().optional(),
  expiry: z.union([z.number(), z.string().transform((v) => parseInt(v, 10))]).optional(),
});

export const payInvoiceParamsSchema = z.object({
  invoice: z.string(),
});

export const payKeysendParamsSchema = z.object({
  amount: z.union([z.number(), z.string().transform((v) => parseInt(v, 10))]),
  // Lightning node pubkey: 33-byte compressed key = 66 hex chars (02/03 prefix),
  // NOT a 32-byte Nostr key. (This regex was wrongly 64 chars and rejected all keysends.)
  pubkey: z.string().regex(/^0[23][0-9a-fA-F]{64}$/, "Invalid public key hex"),
  preimage: z.string().regex(/^[0-9a-fA-F]{64}$/, "Invalid preimage hex").optional(),
  tlv_records: z.array(z.object({
    type: z.number(),
    value: z.string(), // hex value
  })).optional(),
});

export const nwcRequestSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("get_info"),
    params: z.any().optional(),
  }),
  z.object({
    method: z.literal("get_balance"),
    params: z.any().optional(),
  }),
  z.object({
    method: z.literal("make_invoice"),
    params: makeInvoiceParamsSchema,
  }),
  z.object({
    method: z.literal("pay_invoice"),
    params: payInvoiceParamsSchema,
  }),
  z.object({
    method: z.literal("pay_keysend"),
    params: payKeysendParamsSchema,
  }),
]);

export type NWCRequestInput = z.infer<typeof nwcRequestSchema>;

// The NIP-47 methods a connection can be granted. `get_info` is intentionally
// excluded from allowlist gating (see NwcConnection.allowedMethods) because
// clients need it for the initial handshake and it exposes no funds.
export const NWC_GRANTABLE_METHODS = [
  "get_balance",
  "make_invoice",
  "pay_invoice",
  "pay_keysend",
] as const;
export type NwcMethod = (typeof NWC_GRANTABLE_METHODS)[number];

// How a connection's spending budget renews. "never" = a single lifetime budget
// (no reset). The others are rolling windows keyed off `lastSpentTimestamp`.
export const BUDGET_RENEWALS = ["never", "daily", "weekly", "monthly", "yearly"] as const;
export type BudgetRenewal = (typeof BUDGET_RENEWALS)[number];

// Rolling-window lengths (ms). Monthly/yearly are deliberate approximations
// (30d / 365d) so the reset is deterministic and timezone-free — matching the
// existing rolling-daily model rather than calendar-aligned periods.
const RENEWAL_WINDOW_MS: Record<Exclude<BudgetRenewal, "never">, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
  yearly: 365 * 24 * 60 * 60 * 1000,
};

/**
 * Whether a connection's spending budget window has elapsed and should reset.
 * `undefined` renewal defaults to "daily" (the legacy behavior, so pre-existing
 * stored connections keep their 24h reset). "never" never resets.
 */
export function budgetWindowElapsed(
  renewal: BudgetRenewal | undefined,
  lastSpentTimestamp: number,
  now: number
): boolean {
  const r = renewal ?? "daily";
  if (r === "never") return false;
  return now - lastSpentTimestamp >= RENEWAL_WINDOW_MS[r];
}

export interface NwcConnection {
  name: string;
  clientPubkey: string;
  secret: string; // client secret (private key)
  spendingLimitSats: number; // budget cap over the renewal window; 0 for unlimited
  spentTodaySats: number; // spent within the current budget window (name kept for storage back-compat)
  lastSpentTimestamp: number; // start of the current budget window (used to reset it)
  createdAt: number;
  enabled: boolean;
  relayUrl: string;
  // --- Optional controls (all undefined-safe for connections stored before they existed) ---
  budgetRenewal?: BudgetRenewal; // how the budget renews; undefined = "daily" (legacy)
  maxAmountSats?: number; // per-payment cap; undefined/0 = no per-payment cap
  allowedMethods?: NwcMethod[]; // method allowlist; undefined = all methods permitted
  expiresAt?: number; // epoch ms after which the connection is rejected; undefined = never
}
