// Pure mapping between the WebLN provider surface and the wallet's own API.
//
// This is the load-bearing, dependency-free logic: it normalizes the loosely-typed WebLN
// arguments that arrive from a page, calls the injected WalletRpc, and shapes the result back
// into the WebLN response the page expects. It touches no LDK, no chrome APIs, and no DOM, so
// it is fully unit-testable with a mock WalletRpc (see tests/webln-mapping.test.ts).
//
// enable()/isEnabled() are NOT here — those are pure permission concerns resolved in the
// background against the permission store, and never reach the wallet.

// A 33-byte compressed Lightning node pubkey is 66 hex chars with an 02/03 prefix — the same
// shape nwc-schema enforces for pay_keysend. (Not a 32-byte Nostr key.)
const NODE_PUBKEY_RE = /^0[23][0-9a-fA-F]{64}$/;

export interface WalletRpc {
  getInfo(): Promise<{ pubkey: string; alias: string; network: string }>;
  getBalanceSats(): Promise<number>;
  makeInvoice(args: { amountSats: number; memo: string; expirySeconds: number }): Promise<{ paymentRequest: string }>;
  payInvoice(bolt11: string): Promise<{ preimage: string }>;
  keysend(args: {
    destination: string;
    amountSats: number;
    customRecords: Record<number, string>;
  }): Promise<{ preimage: string }>;
}

// The amount a spending method will move, in sats — the background needs this BEFORE the call
// to enforce the per-origin daily cap. Returns 0 for non-spending / zero-amount-unknown cases.
export function spendAmountSats(method: string, params: any): number {
  if (method === "keysend") return toPositiveIntSats((params ?? {}).amount);
  // sendPayment's amount is inside the BOLT11; the cap is enforced by the offscreen host after
  // decode. We return 0 here so the background gate does not double-charge — the offscreen host
  // performs the authoritative cap check against the decoded invoice amount.
  return 0;
}

function toPositiveIntSats(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new WeblnError(`Invalid amount: ${String(v)} (expected a positive integer number of sats)`);
  }
  return n;
}

export class WeblnError extends Error {}

// Normalize WebLN's RequestInvoiceArgs (number | string | object) into concrete sats/memo.
export function normalizeMakeInvoice(params: any): { amountSats: number; memo: string; expirySeconds: number } {
  let amountRaw: unknown;
  let memo = "";
  let expiry = 3600;
  if (params == null) {
    throw new WeblnError("makeInvoice requires an amount");
  }
  if (typeof params === "number" || typeof params === "string") {
    amountRaw = params;
  } else if (typeof params === "object") {
    amountRaw = params.amount ?? params.defaultAmount;
    memo = typeof params.defaultMemo === "string" ? params.defaultMemo : "";
    if (params.expiry != null) expiry = toPositiveIntSats(params.expiry);
  } else {
    throw new WeblnError("Invalid makeInvoice arguments");
  }
  return { amountSats: toPositiveIntSats(amountRaw), memo, expirySeconds: expiry };
}

// Normalize WebLN KeysendArgs. customRecords is Record<string,string>; values are passed to
// the wallet as UTF-8 strings, which matches the bLIP-10 convention (TLV 7629169 is UTF-8 JSON,
// NOT hex). Keys must be numeric TLV types.
export function normalizeKeysend(params: any): {
  destination: string;
  amountSats: number;
  customRecords: Record<number, string>;
} {
  if (params == null || typeof params !== "object") throw new WeblnError("keysend requires { destination, amount }");
  const destination = String(params.destination ?? "").toLowerCase();
  if (!NODE_PUBKEY_RE.test(destination)) {
    throw new WeblnError("keysend destination must be a 66-char hex node pubkey");
  }
  const amountSats = toPositiveIntSats(params.amount);
  const customRecords: Record<number, string> = {};
  const raw = params.customRecords ?? {};
  if (typeof raw !== "object") throw new WeblnError("customRecords must be an object of { tlvType: string }");
  for (const [k, v] of Object.entries(raw)) {
    const type = Number(k);
    if (!Number.isInteger(type) || type < 0) throw new WeblnError(`Invalid TLV type: ${k}`);
    customRecords[type] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return { destination, amountSats, customRecords };
}

export function normalizeSendPayment(params: any): string {
  const bolt11 = typeof params === "string" ? params : params?.paymentRequest;
  if (typeof bolt11 !== "string" || !bolt11.trim()) {
    throw new WeblnError("sendPayment requires a BOLT11 payment request string");
  }
  return bolt11.trim();
}

// The single dispatcher the offscreen host calls for the four wallet-touching WebLN methods.
export async function handleWeblnRequest(rpc: WalletRpc, method: string, params: any): Promise<any> {
  switch (method) {
    case "getInfo": {
      const info = await rpc.getInfo();
      return {
        node: { pubkey: info.pubkey, alias: info.alias, color: "#7a5af5" },
        network: info.network,
        methods: ["getInfo", "makeInvoice", "sendPayment", "keysend"],
      };
    }
    case "makeInvoice": {
      const { paymentRequest } = await rpc.makeInvoice(normalizeMakeInvoice(params));
      return { paymentRequest };
    }
    case "sendPayment": {
      const { preimage } = await rpc.payInvoice(normalizeSendPayment(params));
      return { preimage };
    }
    case "keysend": {
      const { preimage } = await rpc.keysend(normalizeKeysend(params));
      return { preimage };
    }
    default:
      throw new WeblnError(`Unsupported WebLN method: ${method}`);
  }
}
