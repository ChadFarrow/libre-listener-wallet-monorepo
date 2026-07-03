import { describe, it, expect } from "vitest";
import { iconColorFor, ICON_LIVE_COLOR, ICON_IDLE_COLOR } from "./action-icon";

// The toolbar icon reflects node liveness. The drawing itself uses OffscreenCanvas (only in the
// service worker), so here we pin the pure contract: which color, and that "live" stays locked to
// the brand green used everywhere else in the UI (so a CSS change and the icon can't silently drift).
describe("action icon color", () => {
  it("uses the brand green when the node is running", () => {
    expect(iconColorFor(true)).toBe(ICON_LIVE_COLOR);
    // Must match the v4vmusic accent green (--accent) used across popup/options/approval.
    expect(ICON_LIVE_COLOR.toLowerCase()).toBe("#22c45e");
  });

  it("uses a distinct muted grey when the node is stopped", () => {
    expect(iconColorFor(false)).toBe(ICON_IDLE_COLOR);
    expect(ICON_IDLE_COLOR).not.toBe(ICON_LIVE_COLOR);
  });
});
