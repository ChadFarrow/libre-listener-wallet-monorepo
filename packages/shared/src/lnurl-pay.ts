// LNURL-pay / Lightning Address (LUD-16 + LUD-06 + LUD-12) — the pure wire layer.
// Resolution: name@domain → https://domain/.well-known/lnurlp/name → payRequest params →
// callback?amount=<msat> → { pr: bolt11 }. No fetching here (the SDK's lnurl-client
// orchestrates with an injected fetch) and no invoice decoding (that needs LDK, which
// @libre/shared must not depend on — the SDK verifies the returned invoice's amount).

export interface LnAddress {
  name: string;
  domain: string;
}

// LUD-16 local part; domain is a hostname (dots) or loopback host[:port] for dev/regtest.
const NAME_RE = /^[a-z0-9\-_.+]+$/;
const DOMAIN_RE = /^[a-z0-9\-.[\]:]+$/;

export function parseLightningAddress(input: string): LnAddress {
  const s = (input || "").trim().toLowerCase();
  const parts = s.split("@");
  if (parts.length !== 2) throw new Error(`Invalid lightning address (expected name@domain): "${input}"`);
  const [name, domain] = parts;
  if (!name || !NAME_RE.test(name)) throw new Error(`Invalid lightning address name: "${name}"`);
  if (!domain || !DOMAIN_RE.test(domain)) throw new Error(`Invalid lightning address domain: "${domain}"`);
  return { name, domain };
}

function isLoopbackDomain(domain: string): boolean {
  const host = domain.replace(/:\d+$/, "");
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

// LUD-16 well-known endpoint. Always https, except loopback (regtest/dev LNURL servers).
export function lnurlpUrl(addr: LnAddress): string {
  const scheme = isLoopbackDomain(addr.domain) ? "http" : "https";
  return `${scheme}://${addr.domain}/.well-known/lnurlp/${addr.name}`;
}

export interface LnurlPayParams {
  callback: string;
  minSendableMsat: number;
  maxSendableMsat: number;
  metadata: string;
  commentAllowed?: number;
}

function lnurlError(json: Record<string, unknown>): string | undefined {
  if (typeof json.status === "string" && json.status.toUpperCase() === "ERROR") {
    return typeof json.reason === "string" && json.reason ? json.reason : "LNURL server returned an error";
  }
  return undefined;
}

export function parseLnurlPayResponse(json: unknown): LnurlPayParams {
  if (typeof json !== "object" || json === null) throw new Error("LNURL-pay response is not an object");
  const o = json as Record<string, unknown>;
  const err = lnurlError(o);
  if (err) throw new Error(`LNURL-pay error: ${err}`);
  if (o.tag !== "payRequest") throw new Error(`Not an LNURL payRequest (tag: ${String(o.tag)})`);
  const callback = o.callback;
  if (typeof callback !== "string" || !/^https?:\/\//.test(callback)) {
    throw new Error("LNURL-pay callback must be an http(s) URL");
  }
  const min = Number(o.minSendable);
  const max = Number(o.maxSendable);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 1 || max < min) {
    throw new Error(`Invalid sendable bounds: min=${String(o.minSendable)} max=${String(o.maxSendable)}`);
  }
  if (typeof o.metadata !== "string" || !o.metadata) throw new Error("LNURL-pay metadata missing");
  const commentAllowed = Number.isInteger(o.commentAllowed) && (o.commentAllowed as number) > 0
    ? (o.commentAllowed as number)
    : undefined;
  return { callback, minSendableMsat: min, maxSendableMsat: max, metadata: o.metadata, commentAllowed };
}

// Amount is msat per LUD-06. Comments (LUD-12) are included only when the server allows
// one at least that long — never truncated (a cut-off boost message changes its meaning).
export function buildLnurlPayCallbackUrl(params: LnurlPayParams, amountMsat: number, comment?: string): string {
  if (!Number.isInteger(amountMsat)) throw new Error(`Amount must be an integer msat value: ${amountMsat}`);
  if (amountMsat < params.minSendableMsat) {
    throw new Error(`Amount ${amountMsat} msat is below the recipient's minimum (${params.minSendableMsat} msat)`);
  }
  if (amountMsat > params.maxSendableMsat) {
    throw new Error(`Amount ${amountMsat} msat is above the recipient's maximum (${params.maxSendableMsat} msat)`);
  }
  const sep = params.callback.includes("?") ? "&" : "?";
  let url = `${params.callback}${sep}amount=${amountMsat}`;
  if (comment && params.commentAllowed && comment.length <= params.commentAllowed) {
    url += `&comment=${encodeURIComponent(comment)}`;
  }
  return url;
}

export function parseLnurlPayCallbackResponse(json: unknown): { pr: string } {
  if (typeof json !== "object" || json === null) throw new Error("LNURL-pay callback response is not an object");
  const o = json as Record<string, unknown>;
  const err = lnurlError(o);
  if (err) throw new Error(`LNURL-pay error: ${err}`);
  if (typeof o.pr !== "string" || !o.pr) throw new Error("LNURL-pay callback returned no invoice (pr)");
  return { pr: o.pr };
}
