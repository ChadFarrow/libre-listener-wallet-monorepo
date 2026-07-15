import { describe, it, expect } from "vitest";
import {
  parseConfig,
  serializeConfig,
  defaultEsploraUrl,
  defaultBridgeUrl,
  defaultRapidGossipSyncUrl,
  defaultPeer,
  DEFAULT_MAINNET_PEER,
  parsePeerString,
  formatPeerString,
  resolveNodeAlias,
  type AppConfig,
} from "./wallet-config";

describe("resolveNodeAlias", () => {
  it("prefers the dedicated (synced) key over the legacy ldk_config value", () => {
    expect(resolveNodeAlias("From backup", "old legacy")).toBe("From backup");
  });

  it("falls back to the legacy value when the dedicated key is absent (pre-sync install)", () => {
    expect(resolveNodeAlias(null, "Chad's phone")).toBe("Chad's phone");
    expect(resolveNodeAlias(undefined, "Chad's phone")).toBe("Chad's phone");
  });

  it("returns undefined when neither is set", () => {
    expect(resolveNodeAlias(null, undefined)).toBeUndefined();
    expect(resolveNodeAlias("", "")).toBeUndefined();
    expect(resolveNodeAlias("   ", "   ")).toBeUndefined();
  });

  it("trims and ignores whitespace-only values", () => {
    expect(resolveNodeAlias("  Node  ", null)).toBe("Node");
    expect(resolveNodeAlias("   ", "Legacy")).toBe("Legacy");
  });
});

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

describe("AppConfig.peer (persisted last-connected peer)", () => {
  it("round-trips through serialize/parse", () => {
    const cfg: AppConfig = { network: "mainnet", peer: DEFAULT_MAINNET_PEER };
    expect(parseConfig(serializeConfig(cfg)).peer).toBe(DEFAULT_MAINNET_PEER);
  });

  it("is optional: old configs without it parse unchanged (backward compat)", () => {
    const cfg = parseConfig(JSON.stringify({ network: "mainnet", esploraUrl: "https://x/api" }));
    expect(cfg.peer).toBeUndefined();
    expect(cfg.esploraUrl).toBe("https://x/api");
  });

  it("drops a blank peer", () => {
    expect(parseConfig(JSON.stringify({ network: "mainnet", peer: "  " })).peer).toBeUndefined();
  });
});

describe("AppConfig.nodeAlias (user-set node name announced to peers)", () => {
  it("round-trips through serialize/parse", () => {
    const cfg: AppConfig = { network: "mainnet", nodeAlias: "Chad's phone" };
    expect(parseConfig(serializeConfig(cfg)).nodeAlias).toBe("Chad's phone");
  });

  it("is optional: old configs without it parse unchanged (backward compat)", () => {
    expect(parseConfig(JSON.stringify({ network: "mainnet" })).nodeAlias).toBeUndefined();
  });

  it("drops a blank alias", () => {
    expect(parseConfig(JSON.stringify({ network: "mainnet", nodeAlias: "  " })).nodeAlias).toBeUndefined();
  });
});

describe("parsePeerString / formatPeerString", () => {
  it("parses pubkey@host:port", () => {
    const p = parsePeerString(DEFAULT_MAINNET_PEER);
    expect(p.pubkey).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(p.host).toBe("45.33.65.45");
    expect(p.port).toBe(9735);
  });

  it("round-trips with formatPeerString", () => {
    const p = parsePeerString(DEFAULT_MAINNET_PEER);
    expect(formatPeerString(p.pubkey, p.host, p.port)).toBe(DEFAULT_MAINNET_PEER);
  });

  it("rejects malformed input (never dial garbage at boot)", () => {
    expect(() => parsePeerString("")).toThrow();
    expect(() => parsePeerString("nopubkey:9735")).toThrow();
    expect(() => parsePeerString("deadbeef@host:9735")).toThrow(); // pubkey not 66 hex 02/03
    expect(() => parsePeerString(`${"02" + "a".repeat(64)}@:9735`)).toThrow(); // empty host
    expect(() => parsePeerString(`${"02" + "a".repeat(64)}@host:0`)).toThrow(); // bad port
    expect(() => parsePeerString(`${"02" + "a".repeat(64)}@host:99999`)).toThrow();
  });
});
