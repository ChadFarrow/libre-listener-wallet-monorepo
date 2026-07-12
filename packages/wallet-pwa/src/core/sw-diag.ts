// Service-worker → diagnostics bridge.
//
// The main-thread console tap (core/diag-tap.ts) cannot see the service worker's console, so push
// behaviour ("[SW] Push received", "no visible window", …) never made it into a Developer →
// Diagnostics export — leaving push impossible to debug from a user's exported log. This writes SW
// log lines DIRECTLY into the same shared `libre-diagnostics` IndexedDB the main thread exports
// from, so SW activity shows up alongside the app's own trace.
//
// Flushed IMMEDIATELY (one entry per call, no batching): a push event can be the last thing the SW
// does before iOS kills it, so an in-memory batch would be lost exactly when we need it. The write
// is best-effort and swallows its own errors — diagnostics must never break push handling. Callers
// inside a `push` handler should `await` it within `event.waitUntil(...)` so the write lands before
// the worker is reclaimed.
import { DiagStore } from "./diag-store";
import { DEFAULT_DIAG_POLICY, type DiagLevel } from "./diag-log";

const store = new DiagStore();

function truncate(msg: string): string {
  const cap = DEFAULT_DIAG_POLICY.maxLine;
  if (msg.length <= cap) return msg;
  return `${msg.slice(0, cap)}…[+${msg.length - cap} chars]`;
}

// Persist one SW diagnostic line. `now` is injectable for tests; defaults to wall clock (the SW
// runs in the browser where Date.now is available).
export async function swDiag(level: DiagLevel, msg: string, now: number = Date.now()): Promise<void> {
  try {
    await store.append([{ at: now, level, msg: `[SW] ${truncate(msg)}` }], DEFAULT_DIAG_POLICY.cap);
  } catch {
    /* best-effort: a diagnostics write must never break push handling */
  }
}
