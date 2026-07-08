// The gateway push-auth wire contract, shared by its ONLY two speakers: the SDK's
// NwcManager.buildGatewayAuth (signer) and the push gateway's /api/register + /api/unregister
// (verifier). NIP-98-style: the client proves control of its (public) walletPubkey by signing a
// fresh, action/relay/endpoint-bound event — without it, anyone who scrapes a wallet's pubkey off
// a relay could hijack or delete its push subscription. Both sides import these constants + shapes
// so the signer and verifier cannot drift (a one-character tag rename would 401 every deployed
// client). Kept dep-free: signing (nostr-tools finalizeEvent) and signature verification
// (verifyEvent) are injected by the packages that own those deps.

export const GATEWAY_AUTH_KIND = 27235;
export const GATEWAY_AUTH_MAX_AGE_SEC = 300;
export const GATEWAY_AUTH_CONTENT = "libre-push-auth";

export type GatewayAuthAction = "register" | "unregister";

export interface GatewayAuthEventTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/** The unsigned event both sides agree on; the SDK signs it with the wallet key. */
export function buildGatewayAuthTemplate(
  action: GatewayAuthAction,
  relayUrl: string,
  endpoint: string | undefined,
  nowSec: number,
): GatewayAuthEventTemplate {
  const tags: string[][] = [["action", action], ["relay", relayUrl]];
  if (endpoint) tags.push(["endpoint", endpoint]);
  return { kind: GATEWAY_AUTH_KIND, created_at: nowSec, tags, content: GATEWAY_AUTH_CONTENT };
}

/**
 * True only if `auth` is a valid signed event that proves control of `walletPubkey`, targets this
 * exact `action` + `relayUrl` (and, for register, `endpoint`), and is fresh. Every binding must
 * match, so a captured event can't be replayed to a different action/relay/endpoint or reused
 * after it expires. Pure and `now`-injectable; the cryptographic signature check is delegated to
 * the injected `verifyEventFn` (nostr-tools `verifyEvent` in the gateway).
 */
export function verifyGatewayAuth(
  auth: unknown,
  walletPubkey: string,
  action: GatewayAuthAction,
  relayUrl: string,
  verifyEventFn: (ev: any) => boolean,
  opts: { endpoint?: string; now?: number; maxAgeSec?: number } = {},
): boolean {
  if (!auth || typeof auth !== "object") return false;
  const ev = auth as Record<string, unknown>;
  if (ev.kind !== GATEWAY_AUTH_KIND) return false;
  if (typeof ev.pubkey !== "string" || ev.pubkey !== walletPubkey) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const maxAge = opts.maxAgeSec ?? GATEWAY_AUTH_MAX_AGE_SEC;
  if (typeof ev.created_at !== "number" || Math.abs(now - ev.created_at) > maxAge) return false;
  const tags: unknown[] = Array.isArray(ev.tags) ? ev.tags : [];
  const tagVal = (name: string): string | undefined => {
    const t = tags.find((x) => Array.isArray(x) && x[0] === name) as string[] | undefined;
    return t?.[1];
  };
  if (tagVal("action") !== action) return false;
  if (tagVal("relay") !== relayUrl) return false;
  if (action === "register" && (!opts.endpoint || tagVal("endpoint") !== opts.endpoint)) return false;
  try {
    return verifyEventFn(ev);
  } catch {
    return false;
  }
}
