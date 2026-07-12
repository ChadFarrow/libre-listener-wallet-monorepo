import { describe, it, expect } from "vitest";
import { bgChipView } from "./bg-mode";

describe("bgChipView", () => {
  it("is hidden in demo mode (no real node to keep alive)", () => {
    expect(bgChipView({ demo: true, nodeRunning: true, active: false, enabled: true }).visible).toBe(false);
  });

  it("is hidden when the node isn't running", () => {
    expect(bgChipView({ demo: false, nodeRunning: false, active: false, enabled: true }).visible).toBe(false);
  });

  it("offers to turn it on when disabled", () => {
    expect(bgChipView({ demo: false, nodeRunning: true, active: false, enabled: false })).toEqual({
      visible: true,
      on: false,
      text: "Keep boosts running in background",
    });
  });

  it("prompts for the activating tap when enabled but not yet playing", () => {
    // The exact iOS gap: enabled in settings, but audio can't start until a trusted tap.
    expect(bgChipView({ demo: false, nodeRunning: true, active: false, enabled: true })).toEqual({
      visible: true,
      on: false,
      text: "Tap to activate background mode",
    });
  });

  it("confirms once the audio is actually playing", () => {
    expect(bgChipView({ demo: false, nodeRunning: true, active: true, enabled: true })).toEqual({
      visible: true,
      on: true,
      text: "Background mode on",
    });
  });

  it("is hidden on the native APK (background mode is default-on + auto-granted, chip redundant)", () => {
    // Even in the would-be-visible states, native hides the chip entirely.
    expect(bgChipView({ demo: false, nodeRunning: true, active: false, enabled: false, native: true }).visible).toBe(
      false,
    );
    expect(bgChipView({ demo: false, nodeRunning: true, active: true, enabled: true, native: true }).visible).toBe(
      false,
    );
  });
});
