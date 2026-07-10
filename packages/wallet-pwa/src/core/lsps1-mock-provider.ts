// Dev-only LSPS1 provider override: when VITE_LSPS1_MOCK_URL is set (gitignored .env.local, never
// the deploy workflow), layer a "mock" provider over the real ones so the get-a-channel flow can be
// clicked through against @libre/lsps1-mock-server — offline, no real LSP, no sats. Pure so it's
// unit-testable; the views pass import.meta.env.VITE_LSPS1_MOCK_URL in.
import type { Lsps1RestProvider } from "@libre/shared";

export function withMockProvider(
  providers: Record<string, Lsps1RestProvider>,
  mockUrl: string | undefined
): Record<string, Lsps1RestProvider> {
  const url = (mockUrl ?? "").trim();
  if (!url) return providers;
  const mock: Lsps1RestProvider = {
    name: "Local mock LSP",
    restBaseUrl: url,
    supportsZeroConf: true,
    // No nodePubkey: the mock must never be 0-conf-trusted (zeroConfTrustedPubkeys requires one).
    // Bounds mirror the mock server's defaults (MIN_CHANNEL_SAT=150000 … MAX_CHANNEL_SAT=16M).
    minChannelSat: 150_000,
    maxChannelSat: 16_000_000,
    maxLeaseBlocks: 13_140,
    leaseMonthsApprox: 3,
    costNote: "Local dev mock — fake invoice, no real channel, no sats",
  };
  return { mock, ...providers };
}

// The one-tap Create-tab channel order: the mock when configured, otherwise Megalith (the real
// default — smallest instant 0-conf channel).
export function quickChannelProvider(
  providers: Record<string, Lsps1RestProvider>
): Lsps1RestProvider {
  return providers.mock ?? providers.megalith;
}
