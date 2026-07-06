// Auto-start decision logic for the offscreen wallet host. Pure and chrome-free so it is
// unit-testable; the host supplies the storage markers and executes the plan.
//
// The critical row: a seed with NO channel state that was NOT created brand-new here must
// NEVER auto-start — an unattended empty ChannelManager that connects the peer replies
// "unknown channel" to channel_reestablish and force-closes the real channel (the documented
// mainnet failure). That case is a silent skip here AND stays a hard error in startNode().

export const AUTO_START_KEY = "auto_start";

// Default ON — a wallet should just run. Only an explicit "0" disables.
export function isAutoStartEnabled(raw: string | null): boolean {
  return raw !== "0";
}

export interface AutoStartInputs {
  flagRaw: string | null; // raw chrome.storage.local value under AUTO_START_KEY
  hasSeed: boolean;
  hasChannelState: boolean; // channel_manager key present
  createdNew: boolean; // wallet_created_new provenance marker
}

export interface AutoStartPlan {
  start: boolean;
  connectPeer: boolean;
  reason?: string; // why we skipped (logged, never thrown)
}

export function autoStartPlan(i: AutoStartInputs): AutoStartPlan {
  if (!isAutoStartEnabled(i.flagRaw)) {
    return { start: false, connectPeer: false, reason: "auto-start is disabled" };
  }
  if (!i.hasSeed) {
    return { start: false, connectPeer: false, reason: "no wallet on this network" };
  }
  if (!i.hasChannelState && !i.createdNew) {
    return {
      start: false,
      connectPeer: false,
      reason: "seed has no channel state and was not created here — restore from backup first",
    };
  }
  // A brand-new unfunded wallet starts but never auto-dials (mirrors the PWA's gating: only a
  // wallet with existing channel state keeps its peer alive automatically).
  return { start: true, connectPeer: i.hasChannelState };
}

// Boot-time peer dial schedule: the bridge may not be reachable the instant the browser
// launches. After one successful connect the SDK's own auto-reconnect owns the link.
export const PEER_CONNECT_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000, 30_000];

export interface ConnectRetryOpts {
  delaysMs?: readonly number[];
  shouldContinue?: () => boolean; // consulted before each attempt (abort when the node stopped)
  sleep?: (ms: number) => Promise<void>;
  onAttemptFailed?: (attempt: number, error: unknown) => void; // attempt is 1-indexed
}

// Try connect() until it succeeds: one immediate attempt, then one per delay (waiting that
// delay first). Returns true on success, false when exhausted or aborted. Never throws.
export async function connectWithRetry(connect: () => Promise<void>, opts: ConnectRetryOpts = {}): Promise<boolean> {
  const delays = opts.delaysMs ?? PEER_CONNECT_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const shouldContinue = opts.shouldContinue ?? (() => true);
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (!shouldContinue()) return false;
    try {
      await connect();
      return true;
    } catch (e) {
      opts.onAttemptFailed?.(attempt + 1, e);
      if (attempt === delays.length) return false;
      await sleep(delays[attempt]);
    }
  }
  return false;
}
