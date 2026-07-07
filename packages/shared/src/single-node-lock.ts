// One LDK node per origin. A Web Lock held for the node's whole lifetime; a second context in the
// SAME origin (e.g. a PWA's page vs its service worker) that tries to start gets null → must not run.
// Lives in @libre/shared (browser util) so all frontends share it; the SDK stays navigator-free and
// receives the acquirer by injection. Cross-origin/device is NOT covered (no shared lock exists).

export type LockRelease = () => void;

export const NODE_ALREADY_RUNNING_CODE = "NODE_ALREADY_RUNNING";

export function nodeLockName(dbName: string): string {
  return `libre-node:${dbName}`;
}

export function isNodeAlreadyRunningError(e: unknown): boolean {
  if (e == null) return false;
  if (typeof e === "string") return e.includes(NODE_ALREADY_RUNNING_CODE);
  if (typeof e === "object") {
    if ((e as { code?: unknown }).code === NODE_ALREADY_RUNNING_CODE) return true;
    const msg = (e as { message?: unknown }).message;
    return typeof msg === "string" && msg.includes(NODE_ALREADY_RUNNING_CODE);
  }
  return false;
}

/** Acquire the per-origin node lock. Resolves to a release fn (lock held until called), or null if
 *  another context in this origin already holds it. If Web Locks is unavailable, or the request
 *  errors, degrade to a no-op release — never block a legitimate start (best-effort guard). */
export function acquireWebNodeLock(
  name: string,
  locks: LockManager | undefined = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks,
): Promise<LockRelease | null> {
  if (!locks || typeof locks.request !== "function") {
    return Promise.resolve<LockRelease>(() => {});
  }
  return new Promise<LockRelease | null>((resolveOuter) => {
    let settled = false;
    const settle = (v: LockRelease | null) => { if (!settled) { settled = true; resolveOuter(v); } };
    try {
      Promise.resolve(
        locks.request(name, { ifAvailable: true }, (lock) => {
          if (!lock) { settle(null); return; }               // held elsewhere in this origin
          return new Promise<void>((releaseInner) => settle(() => releaseInner())); // hold until release()
        }),
      ).catch(() => settle(() => {})); // async request rejection → don't block; no-op release
    } catch {
      settle(() => {}); // SYNCHRONOUS throw from request() → same degrade
    }
  });
}
