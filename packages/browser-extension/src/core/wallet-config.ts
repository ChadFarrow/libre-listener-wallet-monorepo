import { isBitcoinNetwork, type BitcoinNetwork } from "./storage-namespace";

// The wallet-runtime config the offscreen host needs, persisted (as JSON under the
// `ldk_config` key, matching the PWA's convention) so the host can boot without a UI.
// No localhost defaults for the remote endpoints — a real wallet must be told its esplora
// + bridge explicitly; only the network falls back (to mainnet, the app default).
export interface ExtensionConfig {
  network: BitcoinNetwork;
  esploraUrl?: string;
  bridgeUrl?: string;
  rapidGossipSyncUrl?: string;
}

const CONFIG_KEY = "ldk_config";

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
  } catch {
    return { network: "mainnet" };
  }
}

export function serializeConfig(c: ExtensionConfig): string {
  return JSON.stringify(c);
}

export { CONFIG_KEY };
