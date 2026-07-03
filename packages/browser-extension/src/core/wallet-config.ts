import { isBitcoinNetwork, type BitcoinNetwork } from "./storage-namespace";

// The wallet-runtime config the offscreen host needs, persisted (as JSON under the
// `ldk_config` key, matching the PWA's convention) so the host can boot without a UI.
// The bridge is still explicit (there's no universal default peer bridge), but esplora falls back
// to a public endpoint per network so a fresh install can create/restore and sync without first
// visiting the options page (an undefined esploraUrl otherwise crashed the SDK's sync client).
export interface ExtensionConfig {
  network: BitcoinNetwork;
  esploraUrl?: string;
  bridgeUrl?: string;
  rapidGossipSyncUrl?: string;
}

const CONFIG_KEY = "ldk_config";

// Public Esplora endpoints per network (mainnet matches the PWA default). Used only when the user
// hasn't configured one; they can still override it in Connection settings.
export function defaultEsploraUrl(network: string): string {
  switch (network) {
    case "testnet":
      return "https://mempool.space/testnet/api";
    case "signet":
      return "https://mempool.space/signet/api";
    case "regtest":
      return "http://127.0.0.1:3002";
    case "mainnet":
    default:
      return "https://mempool.space/api";
  }
}

// Mainnet infrastructure defaults — the SAME public endpoints the PWA ships (from its
// VITE_MAINNET_* build vars). Not secrets: the peer pubkey and Railway/gateway URLs are public.
// Baked in so a fresh install points at the same bridge/peer/RGS with no manual config; all are
// overridable in Connection settings. Only mainnet has defaults (other networks are BYO).
export const DEFAULT_MAINNET_BRIDGE = "wss://ws-bridge-production-9e2f.up.railway.app";
export const DEFAULT_MAINNET_PEER = "028ea4e01d6f7e6d80d2d6902eda9304c4bcda78a6abfda3dee2de94ef46a302d5@45.33.65.45:9735";
export const DEFAULT_MAINNET_RGS = "https://nwc-push-gateway-production.up.railway.app/rgs/snapshot";

export function defaultBridgeUrl(network: string): string | undefined {
  return network === "mainnet" ? DEFAULT_MAINNET_BRIDGE : undefined;
}
export function defaultRapidGossipSyncUrl(network: string): string | undefined {
  return network === "mainnet" ? DEFAULT_MAINNET_RGS : undefined;
}
// The channel-peer address (pubkey@host:port) to pre-fill / reconnect. Explicit user action still
// required to connect — nothing auto-dials.
export function defaultPeer(network: string): string | undefined {
  return network === "mainnet" ? DEFAULT_MAINNET_PEER : undefined;
}

export function parseConfig(rawJson: string | null): ExtensionConfig {
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
  if (!rawJson) return { network: "mainnet" };
  try {
    const c = JSON.parse(rawJson);
    return {
      network: isBitcoinNetwork(c.network) ? c.network : "mainnet",
      esploraUrl: str(c.esploraUrl),
      bridgeUrl: str(c.bridgeUrl),
      rapidGossipSyncUrl: str(c.rapidGossipSyncUrl),
    };
  } catch (e) {
    // Don't silently boot mainnet on a corrupt config without a trace (guardrails §4).
    console.warn("[Config] stored ldk_config is unparseable; falling back to mainnet defaults:", (e as Error)?.message || e);
    return { network: "mainnet" };
  }
}

export function serializeConfig(c: ExtensionConfig): string {
  return JSON.stringify(c);
}

export { CONFIG_KEY };
