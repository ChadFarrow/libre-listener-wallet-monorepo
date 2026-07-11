import { describe, it, expect } from "vitest";
import { shouldRefreshOnVisible } from "./resume-refresh";

describe("shouldRefreshOnVisible", () => {
  it("refreshes when the tab becomes visible and the node is running", () => {
    expect(shouldRefreshOnVisible("visible", true)).toBe(true);
  });

  it("does nothing while the tab is hidden (backgrounding — no point, and the freeze is why)", () => {
    expect(shouldRefreshOnVisible("hidden", true)).toBe(false);
  });

  it("does nothing when the node isn't running (no peers to refresh)", () => {
    expect(shouldRefreshOnVisible("visible", false)).toBe(false);
  });
});
