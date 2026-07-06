import { describe, it, expect } from "vitest";
import { channelCountLabel } from "./stat-format";

describe("channelCountLabel", () => {
  it("shows usable/total when both are known", () => {
    expect(channelCountLabel(2, 2)).toBe("2/2");
    expect(channelCountLabel(2, 1)).toBe("1/2");
    expect(channelCountLabel(3, 0)).toBe("0/3");
  });

  it("falls back to the bare total when usable is unknown", () => {
    expect(channelCountLabel(2, undefined)).toBe("2");
    expect(channelCountLabel(0, undefined)).toBe("0");
  });

  it("shows a dash when the node is stopped (no counts at all)", () => {
    expect(channelCountLabel(undefined, undefined)).toBe("—");
  });
});
