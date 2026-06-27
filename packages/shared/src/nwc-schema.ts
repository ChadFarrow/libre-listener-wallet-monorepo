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

export interface NwcConnection {
  name: string;
  clientPubkey: string;
  secret: string; // client secret (private key)
  spendingLimitSats: number; // 0 for unlimited
  spentTodaySats: number;
  lastSpentTimestamp: number; // to reset daily limit
  createdAt: number;
  enabled: boolean;
  relayUrl: string;
}
