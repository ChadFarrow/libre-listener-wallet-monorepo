import { describe, it, expect, vi } from "vitest";
import {
  nodeLockName,
  acquireWebNodeLock,
  NODE_ALREADY_RUNNING_CODE,
  isNodeAlreadyRunningError,
} from "./index";

// Minimal fake of the Web Locks LockManager.request(name, {ifAvailable}, cb).
function fakeLocks(available: boolean) {
  return {
    request: (_name: string, _opts: any, cb: (lock: unknown) => any) => {
      // ifAvailable: when unavailable, the browser invokes cb(null).
      const r = cb(available ? { name: _name } : null);
      return Promise.resolve(r).then(() => undefined);
    },
  } as unknown as LockManager;
}

describe("nodeLockName", () => {
  it("namespaces by db name", () => {
    expect(nodeLockName("libre-wallet-mainnet")).toBe("libre-node:libre-wallet-mainnet");
  });
});

describe("acquireWebNodeLock", () => {
  it("returns a release fn when the lock is free", async () => {
    const release = await acquireWebNodeLock("n", fakeLocks(true));
    expect(typeof release).toBe("function");
    release!(); // idempotent — must not throw
    release!();
  });
  it("returns null when the lock is already held", async () => {
    expect(await acquireWebNodeLock("n", fakeLocks(false))).toBeNull();
  });
  it("degrades to a no-op release when Web Locks is unavailable", async () => {
    const release = await acquireWebNodeLock("n", undefined);
    expect(typeof release).toBe("function"); // never blocks a legit start
  });
});

describe("isNodeAlreadyRunningError", () => {
  it("matches an object by .code and a flattened message string", () => {
    expect(isNodeAlreadyRunningError({ code: NODE_ALREADY_RUNNING_CODE })).toBe(true);
    expect(isNodeAlreadyRunningError(`[${NODE_ALREADY_RUNNING_CODE}] running elsewhere`)).toBe(true);
    expect(isNodeAlreadyRunningError({ message: `[${NODE_ALREADY_RUNNING_CODE}] x` })).toBe(true);
  });
  it("does not match unrelated values", () => {
    expect(isNodeAlreadyRunningError(new Error("boom"))).toBe(false);
    expect(isNodeAlreadyRunningError(null)).toBe(false);
    expect(isNodeAlreadyRunningError({ code: "OTHER" })).toBe(false);
  });
});
