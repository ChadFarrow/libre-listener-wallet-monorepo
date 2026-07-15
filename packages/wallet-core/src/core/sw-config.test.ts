import { describe, it, expect } from "vitest";
import { resolveSwConfig, resolveActiveNetwork, resolvePushConfig } from "./sw-config";
import { defaultEsploraUrl, defaultBridgeUrl } from "./wallet-config";

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

describe("resolveActiveNetwork", () => {
  it("defaults to mainnet (matching the controller) when the meta pointer is unset", () => {
    for (const empty of [null, undefined, "", "   "]) {
      expect(resolveActiveNetwork(empty as any)).toBe("mainnet");
    }
  });

  it("returns the stored network, trimmed", () => {
    expect(resolveActiveNetwork("mainnet")).toBe("mainnet");
    expect(resolveActiveNetwork("regtest")).toBe("regtest");
    expect(resolveActiveNetwork(" signet ")).toBe("signet");
  });
});

describe("resolvePushConfig", () => {
  it("uses the persisted esplora/bridge when present", () => {
    const json = JSON.stringify({
      network: "mainnet",
      esploraUrl: "https://my.esplora/api",
      bridgeUrl: "wss://my.bridge",
    });
    const cfg = resolvePushConfig(json, "mainnet");
    expect(cfg).toEqual({
      network: "mainnet",
      esploraUrl: "https://my.esplora/api",
      bridgeUrl: "wss://my.bridge",
    });
  });

  it("falls back to the network's public defaults on a default-config install (null config)", () => {
    const cfg = resolvePushConfig(null, "mainnet");
    expect(cfg.network).toBe("mainnet");
    // Must resolve the SAME defaults the controller uses so the SW can actually boot.
    expect(cfg.esploraUrl).toBe(defaultEsploraUrl("mainnet"));
    expect(cfg.bridgeUrl).toBe(defaultBridgeUrl("mainnet"));
    expect(cfg.esploraUrl).toBeTruthy();
    expect(cfg.bridgeUrl).toBeTruthy();
  });

  it("resolves esplora for a non-mainnet network but leaves bridge undefined (BYO)", () => {
    const cfg = resolvePushConfig(JSON.stringify({ network: "regtest" }), "regtest");
    expect(cfg.esploraUrl).toBe(defaultEsploraUrl("regtest"));
    expect(cfg.bridgeUrl).toBeUndefined();
  });
});
