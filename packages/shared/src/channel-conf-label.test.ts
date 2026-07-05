import { describe, it, expect } from "vitest";
import { channelConfLabel } from "./index";

describe("channelConfLabel", () => {
  it("shows X/N for a pending channel that needs confirmations", () => {
    expect(channelConfLabel(0, 3, false)).toBe("0/3 confs");
    expect(channelConfLabel(1, 3, false)).toBe("1/3 confs");
    expect(channelConfLabel(3, 3, false)).toBe("3/3 confs");
  });
  it("treats missing confirmations as 0", () => {
    expect(channelConfLabel(undefined, 3, false)).toBe("0/3 confs");
  });
  it("returns empty once the channel is ready", () => {
    expect(channelConfLabel(2, 3, true)).toBe("");
  });
  it("returns empty for a 0-conf channel or unknown requirement", () => {
    expect(channelConfLabel(0, 0, false)).toBe("");
    expect(channelConfLabel(0, undefined, false)).toBe("");
  });
});
