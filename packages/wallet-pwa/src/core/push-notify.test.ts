import { describe, it, expect } from "vitest";
import { shouldNotifyForPush } from "./push-notify";

describe("shouldNotifyForPush", () => {
  it("notifies when there are no window clients (app fully closed)", () => {
    expect(shouldNotifyForPush([])).toBe(true);
  });

  it("notifies when the only window is hidden/frozen (backgrounded iOS PWA)", () => {
    // This is the regression: a backgrounded window still exists but its node is suspended, so the
    // boost won't be handled — we must still raise the tap-to-open notification.
    expect(shouldNotifyForPush(["hidden"])).toBe(true);
    expect(shouldNotifyForPush(["prerender"])).toBe(true);
  });

  it("suppresses only when a window is actually visible (foreground node is handling it)", () => {
    expect(shouldNotifyForPush(["visible"])).toBe(false);
    expect(shouldNotifyForPush(["hidden", "visible"])).toBe(false);
  });
});
