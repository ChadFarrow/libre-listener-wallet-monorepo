import { describe, it, expect, beforeEach } from "vitest";
import {
  shouldKeepAlive,
  keepAliveEnabled,
  setKeepAliveEnabled,
  shouldSeedKeepAliveDefault,
  KEEP_ALIVE_KEY,
} from "./keep-alive";

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

describe("shouldSeedKeepAliveDefault", () => {
  it("seeds ON when native and the toggle is unset", () => {
    expect(shouldSeedKeepAliveDefault(true, null)).toBe(true);
  });
  it("does not re-enable when native and the user explicitly turned it off", () => {
    expect(shouldSeedKeepAliveDefault(true, "0")).toBe(false);
  });
  it("does not touch an already-on native toggle", () => {
    expect(shouldSeedKeepAliveDefault(true, "1")).toBe(false);
  });
  it("never seeds on the browser PWA (audio keep-alive stays opt-in)", () => {
    expect(shouldSeedKeepAliveDefault(false, null)).toBe(false);
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
