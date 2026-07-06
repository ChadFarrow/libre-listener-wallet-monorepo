// Rapid Gossip Sync URL resolution. RGS populates the LDK network graph so the
// wallet can find multi-hop routes (e.g. a v4vmusic boost to an arbitrary artist).
// The browser can't fetch the LDK RGS server directly (CORS-blocked), so the app
// points at a CORS-enabled proxy (the push gateway's /rgs/snapshot route). The LDK
// RGS server only serves *mainnet* snapshots, so RGS is mainnet-only here.

/**
 * Resolve the RGS snapshot base URL for a network.
 * @param network        the active Bitcoin network
 * @param mainnetRgsUrl  raw value of the VITE_MAINNET_RGS env var (may be undefined/blank)
 * @returns the trimmed URL on mainnet when configured, otherwise undefined
 */
export function rgsUrlForNetwork(
  network: string,
  mainnetRgsUrl: string | undefined
): string | undefined {
  if (network !== "mainnet") return undefined;
  const trimmed = mainnetRgsUrl?.trim();
  return trimmed ? trimmed : undefined;
}
