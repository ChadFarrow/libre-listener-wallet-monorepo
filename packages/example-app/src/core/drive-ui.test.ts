import { describe, it, expect } from "vitest";
import { driveButtonView, shouldArmGestureReconnect } from "./drive-ui";

describe("driveButtonView", () => {
  it("shows a success-styled 'Connected' button when connected", () => {
    const v = driveButtonView(true);
    expect(v.label).toContain("Connected");
    expect(v.className).toContain("btn-success");
    expect(v.className).toContain("btn");
  });

  it("shows the neutral 'Connect Drive' button when not connected", () => {
    const v = driveButtonView(false);
    expect(v.label).toBe("Connect Drive");
    expect(v.className).toContain("btn-secondary");
    expect(v.className).not.toContain("btn-success");
  });
});

describe("shouldArmGestureReconnect", () => {
  it("arms when disconnected and a prior-account hint exists", () => {
    // GIS needs a user gesture for a token, so a load-time silent reconnect fails;
    // retry on first interaction only if we have an account to silently reconnect.
    expect(shouldArmGestureReconnect(false, "you@gmail.com")).toBe(true);
  });

  it("does not arm when already connected", () => {
    expect(shouldArmGestureReconnect(true, "you@gmail.com")).toBe(false);
  });

  it("does not arm without a prior-account hint", () => {
    expect(shouldArmGestureReconnect(false, null)).toBe(false);
    expect(shouldArmGestureReconnect(false, "")).toBe(false);
  });
});
