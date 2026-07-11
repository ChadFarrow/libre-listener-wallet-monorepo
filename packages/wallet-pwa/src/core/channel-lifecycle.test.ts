import { describe, it, expect } from "vitest";
import { channelLifecycle } from "./channel-lifecycle";

const BASE = { channels: 0, usableChannels: 0, closeCount: 0, sweepNeedsAddress: false, sweepPendingCount: 0 };

describe("channelLifecycle", () => {
  it("none: fresh wallet, nothing ever happened", () => {
    expect(channelLifecycle(BASE)).toBe("none");
  });
  it("active: a usable channel", () => {
    expect(channelLifecycle({ ...BASE, channels: 1, usableChannels: 1 })).toBe("active");
  });
  it("opening: channel exists but not usable (also covers peer-offline — indistinguishable from counts)", () => {
    expect(channelLifecycle({ ...BASE, channels: 1 })).toBe("opening");
  });
  it("closed-needs-address: no channel + claimable funds waiting on a recovery address", () => {
    expect(channelLifecycle({ ...BASE, closeCount: 1, sweepNeedsAddress: true })).toBe("closed-needs-address");
  });
  it("closed-recovering: no channel + a sweep queued/broadcasting", () => {
    expect(channelLifecycle({ ...BASE, closeCount: 1, sweepPendingCount: 1 })).toBe("closed-recovering");
  });
  it("closed-recovered: a close on record, nothing pending", () => {
    expect(channelLifecycle({ ...BASE, closeCount: 1 })).toBe("closed-recovered");
  });
  it("needs-address outranks recovering (both true → the actionable one wins)", () => {
    expect(channelLifecycle({ ...BASE, closeCount: 1, sweepNeedsAddress: true, sweepPendingCount: 1 })).toBe("closed-needs-address");
  });
  it("an open channel outranks stale close records (new channel after a close)", () => {
    expect(channelLifecycle({ ...BASE, channels: 1, usableChannels: 1, closeCount: 3 })).toBe("active");
  });
  it("sweep signals without a close record still surface (event raced the close record)", () => {
    expect(channelLifecycle({ ...BASE, sweepNeedsAddress: true })).toBe("closed-needs-address");
    expect(channelLifecycle({ ...BASE, sweepPendingCount: 1 })).toBe("closed-recovering");
  });
});
