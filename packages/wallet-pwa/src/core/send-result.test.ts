import { describe, it, expect } from "vitest";
import { sendResultView } from "./send-result";

describe("sendResultView", () => {
  it("renders a settled success with the formatted amount", () => {
    const v = sendResultView("sent", 1000);
    expect(v.kind).toBe("sent");
    expect(v.tone).toBe("ok");
    expect(v.title).toBe("Payment sent");
    expect(v.amountText).toBe("1,000 sats");
  });

  it("renders a pending (in-flight) state as a warning, never a failure", () => {
    const v = sendResultView("pending", 2500);
    expect(v.tone).toBe("warn");
    expect(v.title.toLowerCase()).toContain("in flight");
    // Must steer the user away from resending (double-pay risk).
    expect(v.note.toLowerCase()).toMatch(/resend|twice|don't/);
    expect(v.amountText).toBe("2,500 sats");
  });

  it("omits the amount text when the amount is unknown or non-positive", () => {
    expect(sendResultView("pending").amountText).toBe("");
    expect(sendResultView("sent", 0).amountText).toBe("");
    expect(sendResultView("sent", NaN).amountText).toBe("");
    expect(sendResultView("sent", -5).amountText).toBe("");
  });
});
