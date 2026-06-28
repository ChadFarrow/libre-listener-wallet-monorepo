import { describe, it, expect } from "vitest";
import { reconnectDelayMs } from "../../peer-reconnect";

describe("reconnectDelayMs", () => {
  it("doubles each attempt starting at the base delay", () => {
    expect(reconnectDelayMs(1)).toBe(1000);
    expect(reconnectDelayMs(2)).toBe(2000);
    expect(reconnectDelayMs(3)).toBe(4000);
    expect(reconnectDelayMs(4)).toBe(8000);
  });

  it("caps the delay so backoff never runs away", () => {
    expect(reconnectDelayMs(6)).toBe(30000); // 2^5 * 1000 = 32000 -> capped
    expect(reconnectDelayMs(100)).toBe(30000);
  });

  it("clamps non-positive attempts to the base delay", () => {
    expect(reconnectDelayMs(0)).toBe(1000);
    expect(reconnectDelayMs(-5)).toBe(1000);
  });

  it("respects custom base and cap", () => {
    expect(reconnectDelayMs(1, 500, 5000)).toBe(500);
    expect(reconnectDelayMs(5, 500, 5000)).toBe(5000); // 500*16=8000 -> capped at 5000
  });
});
