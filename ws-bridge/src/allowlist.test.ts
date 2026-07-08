import { describe, it, expect } from "vitest";
import { parseTarget, isPrivateHost, isTargetAllowed } from "./allowlist";

describe("parseTarget", () => {
  it("parses host:port", () => {
    expect(parseTarget("64.23.162.51:9735")).toEqual({ host: "64.23.162.51", port: 9735 });
  });
  it("rejects malformed / out-of-range", () => {
    for (const bad of ["", "nohost", "1.2.3.4:", "1.2.3.4:0", "1.2.3.4:70000", "1.2.3.4:abc"]) {
      expect(parseTarget(bad)).toBeNull();
    }
  });
});

describe("isPrivateHost", () => {
  it("flags loopback/private/link-local/multicast + localhost", () => {
    for (const h of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "172.31.255.255", "169.254.1.1", "224.0.0.1", "localhost", "::1"]) {
      expect(isPrivateHost(h)).toBe(true);
    }
  });
  it("passes public hosts", () => {
    for (const h of ["64.23.162.51", "45.79.192.236", "8.8.8.8", "172.32.0.1"]) {
      expect(isPrivateHost(h)).toBe(false);
    }
  });
  it("flags IPv4-mapped IPv6 (dotted and hex), unspecified, ULA, and link-local IPv6", () => {
    for (const h of [
      "::ffff:127.0.0.1",
      "[::ffff:7f00:1]",
      "::ffff:c0a8:101", // 192.168.1.1
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
    ]) {
      expect(isPrivateHost(h)).toBe(true);
    }
  });
  it("passes a public IPv4-mapped IPv6", () => {
    expect(isPrivateHost("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateHost("::ffff:808:808")).toBe(false);
  });
});

describe("isTargetAllowed", () => {
  const list = new Set(["64.23.162.51:9735", "45.79.192.236:9735", "45.33.65.45:9735"]);
  it("allows an allowlisted public target", () => {
    expect(isTargetAllowed("64.23.162.51:9735", list)).toBe(true);
  });
  it("denies a non-allowlisted target", () => {
    expect(isTargetAllowed("1.2.3.4:9735", list)).toBe(false);
  });
  it("denies a private target even if allowlisted (SSRF guard)", () => {
    const l = new Set(["127.0.0.1:9999"]);
    expect(isTargetAllowed("127.0.0.1:9999", l)).toBe(false);
  });
  it("permits a private target only when allowPrivate is set (tests)", () => {
    const l = new Set(["127.0.0.1:9999"]);
    expect(isTargetAllowed("127.0.0.1:9999", l, { allowPrivate: true })).toBe(true);
  });
  it("denies malformed input", () => {
    expect(isTargetAllowed("garbage", list)).toBe(false);
  });
});
