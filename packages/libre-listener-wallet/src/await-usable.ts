// Bounded poll-until-true helper, used to wait for a usable channel before attempting a payment.
//
// Why this exists: when the wallet resumes from background the channel peer reconnects over
// ~0.5–2s. An NWC payment (boost) that lands in that window would otherwise fail RouteNotFound —
// there's no usable first-hop yet — and the client sees it as failed even though the wallet is
// fine a second later (proven in a live iOS diagnostics capture 2026-07-12). Waiting briefly for
// the peer to come back turns those failures into successes. The wait is pure — nothing is sent —
// so there is NO double-pay risk (unlike retrying a payment that may already be in flight).
//
// Clock + sleep are injectable so the loop is unit-testable without real timers.
export interface PollUntilOptions {
  timeoutMs: number;
  pollMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Resolve true as soon as `predicate()` is true, checking immediately and then every `pollMs`
 * until `timeoutMs` elapses; resolve false if it never becomes true within the window.
 */
export async function pollUntil(predicate: () => boolean, opts: PollUntilOptions): Promise<boolean> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (predicate()) return true;
  const deadline = now() + opts.timeoutMs;
  while (now() < deadline) {
    await sleep(opts.pollMs);
    if (predicate()) return true;
  }
  return false;
}
