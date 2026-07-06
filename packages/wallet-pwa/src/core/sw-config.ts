// Config the service worker needs to boot an LDK node on an offline push wake-up.
// The SW has no DOM, so it reads the config the main app persisted to IndexedDB
// (`ldk_config`). Deliberately returns NO localhost defaults — a deployed SW must use
// the real (remote) esplora + bridge from config, never silently dial 127.0.0.1.

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
