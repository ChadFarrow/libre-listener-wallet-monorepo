// @vitest-environment node
import { describe, it, expect } from "vitest";
import { resolveMinChannelConfirmations, shouldZeroConfAccept } from "../../index";

describe("resolveMinChannelConfirmations", () => {
  it("defaults to 3 (our fundee wait for inbound channels) when unset", () => {
    expect(resolveMinChannelConfirmations(undefined)).toBe(3);
  });
  it("honours an explicit value", () => {
    expect(resolveMinChannelConfirmations(6)).toBe(6);
    expect(resolveMinChannelConfirmations(1)).toBe(1);
  });
  it("clamps below LDK's lower bound of 1 (0-conf must use the trusted-peer path, not global min_depth)", () => {
    expect(resolveMinChannelConfirmations(0)).toBe(1);
    expect(resolveMinChannelConfirmations(-5)).toBe(1);
  });
  it("coerces to an integer", () => {
    expect(resolveMinChannelConfirmations(3.9)).toBe(3);
  });
});

describe("shouldZeroConfAccept", () => {
  it("0-conf accepts only when the peer is trusted AND the opener requested zeroconf", () => {
    expect(shouldZeroConfAccept(true, true)).toBe(true);
  });
  it("never 0-conf for an untrusted peer, even if it requests zeroconf", () => {
    expect(shouldZeroConfAccept(false, true)).toBe(false);
  });
  it("never 0-conf a normal (non-zeroconf) open, even from a trusted peer (avoids 'min depth zero' break)", () => {
    expect(shouldZeroConfAccept(true, false)).toBe(false);
    expect(shouldZeroConfAccept(false, false)).toBe(false);
  });
});
