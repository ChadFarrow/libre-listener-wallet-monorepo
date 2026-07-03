import { describe, it, expect } from "vitest";
import {
  parseConfig,
  defaultEsploraUrl,
  defaultBridgeUrl,
  defaultRapidGossipSyncUrl,
  defaultPeer,
  DEFAULT_MAINNET_PEER,
} from "./wallet-config";

describe("defaultEsploraUrl", () => {
  it("returns a defined public endpoint for every network (never undefined → no SDK crash)", () => {
    expect(defaultEsploraUrl("mainnet")).toBe("https://mempool.space/api");
    expect(defaultEsploraUrl("testnet")).toBe("https://mempool.space/testnet/api");
    expect(defaultEsploraUrl("signet")).toBe("https://mempool.space/signet/api");
    expect(defaultEsploraUrl("regtest")).toBe("http://127.0.0.1:3002");
  });

  it("falls back to mainnet for an unknown network", () => {
    expect(defaultEsploraUrl("weird")).toBe("https://mempool.space/api");
  });
});

describe("mainnet infrastructure defaults", () => {
  it("provides a bridge, RGS, and peer for mainnet (matching the PWA infra)", () => {
    expect(defaultBridgeUrl("mainnet")).toMatch(/^wss:\/\//);
    expect(defaultRapidGossipSyncUrl("mainnet")).toMatch(/\/rgs\/snapshot$/);
    expect(defaultPeer("mainnet")).toBe(DEFAULT_MAINNET_PEER);
    // The peer is a well-formed pubkey@host:port.
    expect(DEFAULT_MAINNET_PEER).toMatch(/^0[23][0-9a-f]{64}@[^:]+:\d+$/);
  });

  it("has no bridge/RGS/peer defaults for non-mainnet networks (BYO)", () => {
    for (const n of ["testnet", "signet", "regtest"]) {
      expect(defaultBridgeUrl(n)).toBeUndefined();
      expect(defaultRapidGossipSyncUrl(n)).toBeUndefined();
      expect(defaultPeer(n)).toBeUndefined();
    }
  });
});

describe("parseConfig", () => {
  it("defaults to mainnet with no endpoints when empty", () => {
    expect(parseConfig(null)).toEqual({ network: "mainnet" });
  });

  it("keeps a valid stored config and drops blank endpoints", () => {
    const cfg = parseConfig(JSON.stringify({ network: "signet", esploraUrl: "https://x/api", bridgeUrl: "  " }));
    expect(cfg.network).toBe("signet");
    expect(cfg.esploraUrl).toBe("https://x/api");
    expect(cfg.bridgeUrl).toBeUndefined();
  });

  it("falls back to mainnet on a corrupt config", () => {
    expect(parseConfig("{not json")).toEqual({ network: "mainnet" });
  });
});
