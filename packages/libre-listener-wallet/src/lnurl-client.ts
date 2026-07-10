// Lightning Address (LUD-16) → verified BOLT11 invoice. Orchestrates the pure wire layer in
// @libre/shared over an injected fetch, then decodes the returned invoice with LDK and verifies
// its amount EXACTLY matches the request — a wrong-amount invoice is how a malicious or buggy
// LNURL server overcharges, so it's rejected here, before any pay path sees it.
//
// Browser caveat: resolution is a cross-origin fetch, so it only reaches lnaddress providers
// that send CORS headers (many do; some don't — same class of problem as the RGS proxy).
import {
  parseLightningAddress,
  lnurlpUrl,
  parseLnurlPayResponse,
  buildLnurlPayCallbackUrl,
  parseLnurlPayCallbackResponse,
  type LnurlPayParams,
} from "@libre/shared";
import { Bolt11Invoice, Option_u64Z_Some } from "lightningdevkit";

export interface ResolvedLnAddressInvoice {
  invoice: string;
  params: LnurlPayParams;
}

export async function resolveLnAddressInvoice(opts: {
  address: string;
  amountMsat: number;
  comment?: string;
  fetchImpl?: typeof fetch;
}): Promise<ResolvedLnAddressInvoice> {
  // Bind to globalThis: a browser's global fetch brand-checks its receiver (see lsps1-rest-client).
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const addr = parseLightningAddress(opts.address);

  const paramsRes = await fetchImpl(lnurlpUrl(addr));
  if (!paramsRes.ok) {
    throw new Error(`LNURL-pay endpoint for ${addr.name}@${addr.domain} returned HTTP ${paramsRes.status}`);
  }
  const params = parseLnurlPayResponse(await paramsRes.json());

  const cbRes = await fetchImpl(buildLnurlPayCallbackUrl(params, opts.amountMsat, opts.comment));
  if (!cbRes.ok) throw new Error(`LNURL-pay callback returned HTTP ${cbRes.status}`);
  const { pr } = parseLnurlPayCallbackResponse(await cbRes.json());

  const invRes = Bolt11Invoice.constructor_from_str(pr);
  if (!invRes.is_ok()) throw new Error("LNURL-pay callback returned an unparseable invoice");
  const invoice = (invRes as any).res as Bolt11Invoice;
  const amt = invoice.amount_milli_satoshis();
  const actual = amt instanceof Option_u64Z_Some ? amt.some : undefined;
  if (actual !== BigInt(opts.amountMsat)) {
    throw new Error(
      `LNURL-pay invoice amount mismatch: requested ${opts.amountMsat} msat, invoice is for ${actual ?? "no amount"}`
    );
  }
  return { invoice: pr, params };
}
