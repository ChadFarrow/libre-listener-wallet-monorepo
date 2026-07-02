// Storage-layer constants — these MUST match the on-disk invariants pinned by the
// storage-contract tests (packages/libre-listener-wallet/src/tests/unit/storage-contract.test.ts
// and packages/example-app/src/core/storage-contract.test.ts). A funded wallet's IndexedDB
// is keyed by these names; changing them here orphans state. Kept as a small copy because
// the example-app module is a private app package, not an importable library. If the pinned
// invariant ever changes, change it there (with a migration) AND here in the same commit.
//
// NOTE: the extension lives in its own chrome-extension://<id> storage origin, separate from
// the PWA. There is no auto-migration between them — moving a wallet in/out of the extension
// goes through the SDK's exportState/importState backup envelope.

export function dbNameForNetwork(network: string): string {
  return `libre-wallet-${network}`;
}

export const META_DB_NAME = "libre-wallet-meta";
export const ACTIVE_NETWORK_KEY = "active_network";

export type BitcoinNetwork = "mainnet" | "testnet" | "regtest" | "signet";

export const SUPPORTED_NETWORKS: BitcoinNetwork[] = ["mainnet", "testnet", "signet", "regtest"];

export function isBitcoinNetwork(v: unknown): v is BitcoinNetwork {
  return typeof v === "string" && (SUPPORTED_NETWORKS as string[]).includes(v);
}
