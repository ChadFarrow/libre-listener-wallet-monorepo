// Peer auto-reconnect backoff. A browser/PWA wallet dials its channel peer out through
// a bridge; if that connection drops (tab sleep, network flap, peer restart) the channel
// stops being a usable first hop and the wallet silently loses the ability to SEND until
// it reconnects. The wallet redials dropped peers with this exponential backoff.

/**
 * Delay before the Nth reconnect attempt (attempt starts at 1): exponential backoff
 * (base, 2×base, 4×base, …) capped at capMs. Attempts < 1 are treated as 1.
 */
export function reconnectDelayMs(attempt: number, baseMs = 1000, capMs = 30000): number {
  const n = attempt < 1 ? 1 : attempt;
  return Math.min(capMs, baseMs * 2 ** (n - 1));
}
