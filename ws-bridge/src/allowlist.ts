// Target policy for the multi-target bridge. The bridge connects ONLY to exact host:port entries
// in the operator allowlist, and never to a private/loopback/link-local/multicast address (defense
// in depth against an allowlist typo). allowPrivate is a test-only escape hatch (loopback echo
// servers), mirroring the gateway's allowPrivateRelays.
export interface Target {
  host: string;
  port: number;
}

export function parseTarget(raw: string): Target | null {
  if (!raw) return null;
  const at = raw.lastIndexOf(":");
  if (at <= 0 || at === raw.length - 1) return null;
  const host = raw.slice(0, at);
  const port = Number(raw.slice(at + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

const PRIVATE_V4: RegExp[] = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^(22[4-9]|23\d)\./, // 224-239 multicast
];

// If `h` is an IPv4-mapped IPv6 address (::ffff:a.b.c.d dotted, or its ::ffff:HHHH:HHHH hex
// form), return the embedded IPv4 so its privateness can be re-checked; otherwise null. This
// closes the SSRF hole where `[::ffff:127.0.0.1]` (or its hex form `[::ffff:7f00:1]`) slips
// past a naive IPv4 string match to reach loopback.
// NOTE: kept in sync BY HAND with the gateway's copy (packages/libre-nwc-push-gateway
// src/index.ts) — this package can't import @libre/shared because Railway builds it with
// Root Directory=ws-bridge, where workspace packages don't resolve.
function mappedIpv4(h: string): string | null {
  const dotted = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];
  const hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "::") return true;
  // IPv4-mapped IPv6 — judge by the embedded IPv4.
  const mapped = mappedIpv4(h);
  if (mapped) return PRIVATE_V4.some((re) => re.test(mapped));
  // IPv6 unique-local (fc00::/7 → hex starts fc/fd) and link-local (fe80::/10)
  if (/^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith("fe80:")) return true;
  return PRIVATE_V4.some((re) => re.test(h));
}

export function isTargetAllowed(
  raw: string,
  allowlist: Set<string>,
  opts: { allowPrivate?: boolean } = {}
): boolean {
  const t = parseTarget(raw);
  if (!t) return false;
  if (!opts.allowPrivate && isPrivateHost(t.host)) return false;
  return allowlist.has(`${t.host}:${t.port}`);
}
