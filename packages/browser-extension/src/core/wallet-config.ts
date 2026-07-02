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
