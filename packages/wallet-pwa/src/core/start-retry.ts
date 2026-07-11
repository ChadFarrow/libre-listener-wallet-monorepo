import { isNodeAlreadyRunningError } from "@libre/shared";

// Auto-retry policy for a NODE_ALREADY_RUNNING start failure. The single-node Web Lock is held by
// another context in this origin — on iOS usually a bfcache-frozen sibling page the OS hasn't
// reaped yet. It frees within seconds once reaped, so instead of latching a dead "already running"
// pill until the user taps Start, we auto-retry a bounded handful of times. Pure so the bound +
// the resume-retry decision are unit-tested; the controller owns the timer.
export const NODE_LOCK_RETRY_MAX = 6;
export const NODE_LOCK_RETRY_DELAY_MS = 3000; // ~6 × 3s ≈ 18s of self-healing before giving up

export function nodeLockRetryPlan(nextAttempt: number): { retry: boolean; delayMs: number } {
  return nextAttempt <= NODE_LOCK_RETRY_MAX
    ? { retry: true, delayMs: NODE_LOCK_RETRY_DELAY_MS }
    : { retry: false, delayMs: 0 };
}

// Should a foreground-resume re-attempt starting the node? Only when it's stopped AND the last
// start failed on the single-node lock — a resume is exactly when iOS reaps the stale sibling that
// was holding it, so it's a good moment to try again beyond the bounded timer's window.
export function shouldRetryStartOnResume(lastStartError: string | undefined, running: boolean): boolean {
  if (running || !lastStartError) return false;
  return isNodeAlreadyRunningError(lastStartError);
}
