import { describe, it, expect } from "vitest";
import { nodeLockRetryPlan, shouldRetryStartOnResume, NODE_LOCK_RETRY_MAX } from "./start-retry";

describe("nodeLockRetryPlan", () => {
  it("retries within the bound", () => {
    expect(nodeLockRetryPlan(1).retry).toBe(true);
    expect(nodeLockRetryPlan(NODE_LOCK_RETRY_MAX).retry).toBe(true);
    expect(nodeLockRetryPlan(1).delayMs).toBeGreaterThan(0);
  });

  it("gives up past the max attempts (doesn't spin forever)", () => {
    expect(nodeLockRetryPlan(NODE_LOCK_RETRY_MAX + 1).retry).toBe(false);
  });
});

describe("shouldRetryStartOnResume", () => {
  it("retries when stopped with a NODE_ALREADY_RUNNING error (stale sibling lock, reaped on resume)", () => {
    expect(shouldRetryStartOnResume("[NODE_ALREADY_RUNNING] This wallet is already running", false)).toBe(true);
  });

  it("does nothing when the node is already running", () => {
    expect(shouldRetryStartOnResume("[NODE_ALREADY_RUNNING] ...", true)).toBe(false);
  });

  it("does nothing with no error or a non-lock error (don't paper over a real start failure)", () => {
    expect(shouldRetryStartOnResume(undefined, false)).toBe(false);
    expect(shouldRetryStartOnResume("Esplora 429 Too Many Requests", false)).toBe(false);
  });
});
