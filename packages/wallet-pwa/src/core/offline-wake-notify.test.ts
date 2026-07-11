import { describe, it, expect } from "vitest";
import { offlineWakeNotification } from "./offline-wake-notify";

describe("offlineWakeNotification", () => {
  it("returns a success notification when the payment settled", () => {
    const n = offlineWakeNotification({ kind: "settled", method: "pay_keysend" });
    expect(n.title).toBe("Payment sent");
    expect(n.tag).toBe("nwc-payment-sent");
    expect(n.body.length).toBeGreaterThan(0);
  });

  it("surfaces the error reason when the payment failed", () => {
    const n = offlineWakeNotification({ kind: "failed", error: "no route" });
    expect(n.title.toLowerCase()).toContain("didn't");
    expect(n.body).toContain("no route");
    expect(n.tag).toBe("nwc-payment-failed");
  });

  it("falls back to a generic failure body when there's no error text", () => {
    const n = offlineWakeNotification({ kind: "failed" });
    expect(n.tag).toBe("nwc-payment-failed");
    expect(n.body.length).toBeGreaterThan(0);
  });

  it("returns the pending notification on timeout", () => {
    const n = offlineWakeNotification({ kind: "timeout" });
    expect(n.tag).toBe("nwc-payment-pending");
    expect(n.body.toLowerCase()).toContain("tap to open");
  });

  it("always yields a non-empty title/body/tag (iOS requires a visible notification per push)", () => {
    for (const o of [
      { kind: "settled" as const },
      { kind: "failed" as const },
      { kind: "timeout" as const },
    ]) {
      const n = offlineWakeNotification(o);
      expect(n.title).toBeTruthy();
      expect(n.body).toBeTruthy();
      expect(n.tag).toBeTruthy();
    }
  });
});
