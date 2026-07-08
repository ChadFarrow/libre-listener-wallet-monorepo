import { z } from "zod";
import { parseStrictInt } from "./strict-int";

export const getInfoParamsSchema = z.object({}).optional();
export const getBalanceParamsSchema = z.object({}).optional();

// Coerce a number-or-string field to an integer, validating strictly. A string is
// accepted ONLY if it passes `parseStrictInt` (plain canonical base-10 integer), so
// lossy/ambiguous forms a client might send — `"1e9"` (parseInt → 1), `"1,000"`
// (→ 1), `"-5"`, `""` — are rejected at the boundary instead of silently truncating.
// `mustBePositive` distinguishes an amount (must be > 0) from a bound like expiry
// (>= 0). A failed coercion adds a Zod issue so `.parse` throws → the NWC layer
// answers INVALID_PARAMS rather than handing a NaN/negative to a spend-cap check.
function intField(mustBePositive: boolean) {
  return z.union([z.number(), z.string()]).transform((v, ctx) => {
    const n = typeof v === "number" ? v : (parseStrictInt(v) ?? NaN);
    if (!Number.isInteger(n) || (mustBePositive ? n <= 0 : n < 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: mustBePositive
          ? "must be a positive integer"
          : "must be a non-negative integer",
      });
      return z.NEVER;
    }
    return n;
  });
}

const positiveIntField = intField(true);
const nonNegativeIntField = intField(false);

export const makeInvoiceParamsSchema = z.object({
  amount: positiveIntField,
  description: z.string().optional(),
  description_hash: z.string().optional(),
  expiry: nonNegativeIntField.optional(),
});

export const payInvoiceParamsSchema = z.object({
  invoice: z.string(),
});

export const payKeysendParamsSchema = z.object({
  amount: positiveIntField,
  // Lightning node pubkey: 33-byte compressed key = 66 hex chars (02/03 prefix),
  // NOT a 32-byte Nostr key. (This regex was wrongly 64 chars and rejected all keysends.)
  pubkey: z.string().regex(/^0[23][0-9a-fA-F]{64}$/, "Invalid public key hex"),
  preimage: z.string().regex(/^[0-9a-fA-F]{64}$/, "Invalid preimage hex").optional(),
  tlv_records: z.array(z.object({
    type: z.number(),
    value: z.string(), // hex value
  })).optional(),
});

// NIP-47 list_transactions params — all optional. Numeric fields accept number-or-string
// (some clients send strings, matching make_invoice/pay_keysend above) but must coerce to a
// non-negative integer; garbage (`"yesterday"`, `NaN`) is rejected as INVALID_PARAMS rather
// than silently blanking the whole history (a NaN bound makes every `>=`/`<=` comparison false).
export const listTransactionsParamsSchema = z
  .object({
    from: nonNegativeIntField.optional(),
    until: nonNegativeIntField.optional(),
    limit: nonNegativeIntField.optional(),
    offset: nonNegativeIntField.optional(),
    unpaid: z.boolean().optional(),
    type: z.enum(["incoming", "outgoing"]).optional(),
  })
  .optional();

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
  z.object({
    method: z.literal("list_transactions"),
    params: listTransactionsParamsSchema,
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
// `get_info` and `list_transactions` are intentionally NOT grantable: they're always
// permitted (they expose no funds — a handshake capability and read-only history), so
// clients like Alby Go get history regardless of a pairing's spend allowlist. See the
// gate in nwc-manager.ts.
export const NWC_ALWAYS_ALLOWED_METHODS = ["get_info", "list_transactions"] as const;
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
