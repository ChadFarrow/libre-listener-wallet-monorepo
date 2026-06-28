import { describe, it, expect } from "vitest";
import { resolveSwConfig } from "./sw-config";

describe("resolveSwConfig", () => {
  it("returns network + esplora + bridge from a persisted ldk_config", () => {
    const json = JSON.stringify({
      network: "mainnet",
      esploraUrl: "https://mempool.space/api",
      bridgeUrl: "wss://bridge.example.com",
    });
    expect(resolveSwConfig(json)).toEqual({
      network: "mainnet",
      esploraUrl: "https://mempool.space/api",
      bridgeUrl: "wss://bridge.example.com",
    });
  });

  it("does NOT invent a localhost bridge/esplora when the config lacks them", () => {
    const v = resolveSwConfig(JSON.stringify({ network: "mainnet" }));
    expect(v.network).toBe("mainnet");
    expect(v.esploraUrl).toBeUndefined();
    expect(v.bridgeUrl).toBeUndefined();
  });

  it("falls back to a safe default on null or invalid JSON (no localhost URLs)", () => {
    for (const bad of [null, "", "{not json"]) {
      const v = resolveSwConfig(bad as any);
      expect(v.network).toBe("regtest");
      expect(v.esploraUrl).toBeUndefined();
      expect(v.bridgeUrl).toBeUndefined();
    }
  });

  it("ignores empty-string fields", () => {
    const v = resolveSwConfig(JSON.stringify({ network: "signet", esploraUrl: "", bridgeUrl: "" }));
    expect(v.network).toBe("signet");
    expect(v.esploraUrl).toBeUndefined();
    expect(v.bridgeUrl).toBeUndefined();
  });
});
