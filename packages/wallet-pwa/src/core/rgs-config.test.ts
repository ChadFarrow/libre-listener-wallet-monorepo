import { describe, it, expect } from "vitest";
import { rgsUrlForNetwork } from "./rgs-config";

describe("rgsUrlForNetwork", () => {
  const URL = "https://gw.example.com/rgs/snapshot";

  it("returns the configured URL on mainnet", () => {
    expect(rgsUrlForNetwork("mainnet", URL)).toBe(URL);
  });

  it("trims surrounding whitespace from the URL", () => {
    expect(rgsUrlForNetwork("mainnet", `  ${URL}  `)).toBe(URL);
  });

  it("returns undefined on mainnet when no URL is configured", () => {
    expect(rgsUrlForNetwork("mainnet", undefined)).toBeUndefined();
    expect(rgsUrlForNetwork("mainnet", "")).toBeUndefined();
    expect(rgsUrlForNetwork("mainnet", "   ")).toBeUndefined();
  });

  it("returns undefined on non-mainnet networks even when a URL is configured", () => {
    // The LDK RGS server only serves mainnet snapshots, so other networks never use it.
    for (const net of ["regtest", "signet", "testnet"]) {
      expect(rgsUrlForNetwork(net, URL)).toBeUndefined();
    }
  });
});
