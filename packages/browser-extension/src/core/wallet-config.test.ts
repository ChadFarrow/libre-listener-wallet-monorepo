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
  type ExtensionConfig,
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

describe("ExtensionConfig.peer (persisted last-connected peer)", () => {
  it("round-trips through serialize/parse", () => {
    const cfg: ExtensionConfig = { network: "mainnet", peer: DEFAULT_MAINNET_PEER };
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
