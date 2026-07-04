import { describe, it, expect } from "vitest";
import { clientIp } from "./client-ip";

describe("clientIp", () => {
  it("uses a single X-Forwarded-For value", () => {
    expect(clientIp("1.2.3.4", "10.0.0.1")).toBe("1.2.3.4");
  });

  it("uses the leftmost (client) entry of a multi-hop X-Forwarded-For", () => {
    expect(clientIp("1.2.3.4, 10.0.0.1", "10.0.0.1")).toBe("1.2.3.4");
  });

  it("handles the array form of the header, taking the leftmost entry of the first value", () => {
    expect(clientIp(["1.2.3.4, 10.0.0.1"], "10.0.0.1")).toBe("1.2.3.4");
  });

  it("trims surrounding whitespace", () => {
    expect(clientIp("  1.2.3.4  ,  10.0.0.1  ", "10.0.0.1")).toBe("1.2.3.4");
  });

  it("falls back to remoteAddress when XFF is absent", () => {
    expect(clientIp(undefined, "10.0.0.1")).toBe("10.0.0.1");
  });

  it("falls back to \"?\" when both are absent", () => {
    expect(clientIp(undefined, undefined)).toBe("?");
  });
});
