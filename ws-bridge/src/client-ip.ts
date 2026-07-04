/**
 * Resolves the real client IP from an `X-Forwarded-For` header, falling back
 * to the raw socket's remote address.
 *
 * Behind a reverse proxy (e.g. Railway), `req.socket.remoteAddress` is the
 * proxy's own IP — identical for every user — so it can't be used for a
 * per-user cap. `X-Forwarded-For` carries the hop chain as
 * `client, proxy1, proxy2, ...`; the leftmost entry is the original client.
 */
export function clientIp(xff: string | string[] | undefined, remoteAddress: string | undefined): string {
  const raw = Array.isArray(xff) ? xff[0] : xff;
  if (raw) {
    const first = raw.split(",")[0]?.trim();
    if (first) return first;
  }
  return remoteAddress ?? "?";
}
