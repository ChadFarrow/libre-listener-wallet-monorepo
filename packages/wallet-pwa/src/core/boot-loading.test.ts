import { describe, it, expect } from "vitest";
import { bootLoadingVisible } from "./boot-loading";

describe("bootLoadingVisible", () => {
  it("shows while a start is actually in flight", () => {
    expect(bootLoadingVisible({ running: false, starting: true, settling: false, autoStartOn: false })).toBe(true);
  });

  it("shows during the settle window when auto-start will bring the node up", () => {
    expect(bootLoadingVisible({ running: false, starting: false, settling: true, autoStartOn: true })).toBe(true);
  });

  it("never shows once the node is running (the real balance takes over)", () => {
    expect(bootLoadingVisible({ running: true, starting: true, settling: true, autoStartOn: true })).toBe(false);
  });

  it("does NOT claim to be loading a stopped wallet whose auto-start is off", () => {
    // Nothing is coming up on its own — the "tap to start" pill owns this after the settle window.
    expect(bootLoadingVisible({ running: false, starting: false, settling: true, autoStartOn: false })).toBe(false);
  });

  it("is hidden once the settle window has passed and no start is in flight", () => {
    expect(bootLoadingVisible({ running: false, starting: false, settling: false, autoStartOn: true })).toBe(false);
  });
});
