import { describe, it, expect } from "vitest";
import { pollUntil } from "../../await-usable";

// A deterministic fake clock + sleep so the poll loop is testable without real timers.
function fakeTime() {
  let t = 0;
  const now = () => t;
  const sleep = (ms: number) => {
    t += ms;
    return Promise.resolve();
  };
  return { now, sleep };
}

describe("pollUntil", () => {
  it("returns true immediately when the predicate is already satisfied (no wait)", async () => {
    const { now, sleep } = fakeTime();
    let checks = 0;
    const ok = await pollUntil(() => { checks++; return true; }, { timeoutMs: 8000, pollMs: 250, now, sleep });
    expect(ok).toBe(true);
    expect(checks).toBe(1); // checked once, never slept
    expect(now()).toBe(0);
  });

  it("resolves true as soon as the predicate flips (peer reconnected mid-window)", async () => {
    const { now, sleep } = fakeTime();
    let usableAt = 1000; // becomes usable after 1s of virtual time
    const ok = await pollUntil(() => now() >= usableAt, { timeoutMs: 8000, pollMs: 250, now, sleep });
    expect(ok).toBe(true);
    // 250ms polls: 250,500,750,1000 → true at 1000ms, well within the 8s bound
    expect(now()).toBe(1000);
  });

  it("returns false after the timeout when it never becomes true", async () => {
    const { now, sleep } = fakeTime();
    const ok = await pollUntil(() => false, { timeoutMs: 1000, pollMs: 250, now, sleep });
    expect(ok).toBe(false);
    expect(now()).toBeGreaterThanOrEqual(1000);
  });
});
