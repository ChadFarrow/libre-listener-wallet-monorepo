import { describe, it, expect } from "vitest";
import { assessStartReadiness } from "./wallet-readiness";

describe("assessStartReadiness", () => {
  it("returns onboarding (no start) when there is no seed", () => {
    const v = assessStartReadiness({ hasSeed: false, hasChannelState: false, createdNew: false });
    expect(v.canStart).toBe(false);
    expect(v.needsRestore).toBe(false);
  });

  it("allows start for a returning/restored wallet that has channel state", () => {
    const v = assessStartReadiness({ hasSeed: true, hasChannelState: true, createdNew: false });
    expect(v.canStart).toBe(true);
    expect(v.needsRestore).toBe(false);
  });

  it("allows start for an intentionally-fresh new wallet (seed, no channels, created here)", () => {
    const v = assessStartReadiness({ hasSeed: true, hasChannelState: false, createdNew: true });
    expect(v.canStart).toBe(true);
    expect(v.needsRestore).toBe(false);
  });

  it("BLOCKS and demands restore when a seed exists but channel state is missing and it wasn't freshly created", () => {
    // This is the dangerous case: a seed that previously had channels, restored incompletely.
    // Starting + connecting here force-closes the channel.
    const v = assessStartReadiness({ hasSeed: true, hasChannelState: false, createdNew: false });
    expect(v.canStart).toBe(false);
    expect(v.needsRestore).toBe(true);
    expect(v.message).toMatch(/restore/i);
  });
});
