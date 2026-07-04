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

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
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
