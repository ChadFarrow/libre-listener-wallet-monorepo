import { describe, it, expect } from "vitest";
import { CHANNEL_STATE_REGRESSION_CODE, isChannelStateRegressionError } from "./index";

describe("isChannelStateRegressionError", () => {
  it("matches an in-process error object by .code", () => {
    const e = { code: CHANNEL_STATE_REGRESSION_CODE, message: "anything" };
    expect(isChannelStateRegressionError(e)).toBe(true);
  });

  it("matches a real Error whose message carries the token (cross-process / flattened)", () => {
    const e = new Error(`[${CHANNEL_STATE_REGRESSION_CODE}] Channel state regressed: ... restore from a backup.`);
    expect(isChannelStateRegressionError(e)).toBe(true);
  });

  it("matches a bare flattened string containing the token", () => {
    expect(isChannelStateRegressionError(`[${CHANNEL_STATE_REGRESSION_CODE}] halt`)).toBe(true);
  });

  it("matches a plain object whose message carries the token", () => {
    expect(isChannelStateRegressionError({ message: `[${CHANNEL_STATE_REGRESSION_CODE}] halt` })).toBe(true);
  });

  it("does not match a generic Error", () => {
    expect(isChannelStateRegressionError(new Error("boom"))).toBe(false);
  });

  it("does not match unrelated values", () => {
    expect(isChannelStateRegressionError(null)).toBe(false);
    expect(isChannelStateRegressionError(undefined)).toBe(false);
    expect(isChannelStateRegressionError("unrelated")).toBe(false);
    expect(isChannelStateRegressionError({ code: "OTHER" })).toBe(false);
    expect(isChannelStateRegressionError(42)).toBe(false);
  });
});
