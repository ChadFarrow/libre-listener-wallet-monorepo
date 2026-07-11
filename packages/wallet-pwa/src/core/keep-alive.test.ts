import { describe, it, expect, beforeEach } from "vitest";
import { shouldKeepAlive, keepAliveEnabled, setKeepAliveEnabled, KEEP_ALIVE_KEY } from "./keep-alive";

describe("shouldKeepAlive", () => {
  it("runs only when enabled AND running AND not demo", () => {
    expect(shouldKeepAlive({ enabled: true, running: true, demo: false })).toBe(true);
  });
  it("does not run when disabled", () => {
    expect(shouldKeepAlive({ enabled: false, running: true, demo: false })).toBe(false);
  });
  it("does not run when the node is stopped (nothing to keep alive)", () => {
    expect(shouldKeepAlive({ enabled: true, running: false, demo: false })).toBe(false);
  });
  it("never runs in demo (no real node)", () => {
    expect(shouldKeepAlive({ enabled: true, running: true, demo: true })).toBe(false);
  });
});

describe("keepAlive toggle persistence", () => {
  beforeEach(() => localStorage.clear());
  it("defaults to off", () => {
    expect(keepAliveEnabled()).toBe(false);
  });
  it("round-trips through localStorage", () => {
    setKeepAliveEnabled(true);
    expect(localStorage.getItem(KEEP_ALIVE_KEY)).toBe("1");
    expect(keepAliveEnabled()).toBe(true);
    setKeepAliveEnabled(false);
    expect(keepAliveEnabled()).toBe(false);
  });
});
