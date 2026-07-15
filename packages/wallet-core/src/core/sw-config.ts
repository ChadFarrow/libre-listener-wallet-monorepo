// Config the service worker needs to boot an LDK node on an offline push wake-up.
// The SW has no DOM, so it reads the config the main app persisted to IndexedDB
// (`ldk_config`). Deliberately returns NO localhost defaults — a deployed SW must use
// the real (remote) esplora + bridge from config, never silently dial 127.0.0.1.

import { defaultEsploraUrl, defaultBridgeUrl } from "./wallet-config";

export interface SwResolvedConfig {
  network: string;
  esploraUrl?: string;
  bridgeUrl?: string;
}

export function resolveSwConfig(rawJson: string | null): SwResolvedConfig {
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v : undefined;
  if (!rawJson) return { network: "regtest" };
  try {
    const c = JSON.parse(rawJson);
    return {
      network: str(c.network) ?? "regtest",
      esploraUrl: str(c.esploraUrl),
      bridgeUrl: str(c.bridgeUrl),
    };
  } catch {
    return { network: "regtest" };
  }
}

// The meta-DB active-network pointer the SW reads MUST default to the SAME network the
// controller defaults to (mainnet) — the controller resolves defaults in-memory and only
// persists the pointer on start/create, so an early/never-written pointer must NOT fall
// back to "regtest" (that opened the wrong empty DB and silently aborted the push wake).
export function resolveActiveNetwork(raw: string | null | undefined): string {
  return typeof raw === "string" && raw.trim() ? raw.trim() : "mainnet";
}

export interface PushBootConfig {
  network: string;
  esploraUrl?: string;
  bridgeUrl?: string;
}

// Layer the persisted `ldk_config` over the network's public defaults (the SAME constants
// the controller falls back to when building the wallet) so the SW can boot on a default-
// config install that never wrote esplora/bridge explicitly. esplora resolves for every
// network; bridge only has a default on mainnet (others are BYO → undefined, and the SW
// falls back to a tap-to-open notification).
export function resolvePushConfig(rawJson: string | null, network: string): PushBootConfig {
  const base = resolveSwConfig(rawJson);
  return {
    network,
    esploraUrl: base.esploraUrl || defaultEsploraUrl(network),
    bridgeUrl: base.bridgeUrl || defaultBridgeUrl(network),
  };
}
