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

/**
 * Whether a scheduled redial should actually dial when its timer fires. `connectedInLdk`
 * (PeerManager.list_peers()) matters independently of our own descriptor map: if a duplicate
 * connection was ever opened and killed by LDK ("Got second connection with <peer>, closing"),
 * the duplicate's registration overwrote — and its death then deleted — the map entry for the
 * ORIGINAL still-live connection. Redialing in that state mints the next duplicate, forever
 * (a 1↔2 peer-count flap). LDK's list is the ground truth for "already connected".
 */
export function shouldRedialNow(state: {
  running: boolean;
  desired: boolean;
  connectedInMap: boolean;
  connectedInLdk: boolean;
}): boolean {
  return state.running && state.desired && !state.connectedInMap && !state.connectedInLdk;
}
