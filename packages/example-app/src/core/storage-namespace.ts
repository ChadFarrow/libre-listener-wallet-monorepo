// Per-network storage isolation. Each Bitcoin network gets its own IndexedDB so
// switching networks can never corrupt another network's channel state.
export interface ReadableStore {
  keys(): Promise<string[]>;
  getItem(key: string): Promise<string | null>;
}
export interface WritableStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export function dbNameForNetwork(network: string): string {
  return `libre-wallet-${network}`;
}

// Lightweight meta DB that persists a pointer to the currently active network so
// off-page code (service worker, simulate-offline helper) opens the right DB.
// No IndexedDB code lives here — just the constants; callers instantiate the DB.
export const META_DB_NAME = "libre-wallet-meta";
export const ACTIVE_NETWORK_KEY = "active_network";

// Copy every key from source into target, but ONLY when the target has no wallet
// yet (no ldk_seed) — never overwrites. Returns the number of keys copied.
//
// Crash-safety: ldk_seed is written LAST. The skip-guard checks for ldk_seed in
// the target, so writing it first on a partial copy would make an interrupted
// migration look "complete" forever (with 0 monitors). Writing it last means an
// interrupted copy retries fully on the next load.
export async function migrateStorage(source: ReadableStore, target: WritableStore): Promise<number> {
  if (await target.getItem("ldk_seed")) return 0; // target already a wallet — leave it alone
  const keys = await source.keys();
  let copied = 0;
  let seedValue: string | null = null;
  for (const k of keys) {
    if (k === "ldk_seed") {
      seedValue = await source.getItem(k); // defer — write last
      continue;
    }
    const v = await source.getItem(k);
    if (v !== null) {
      await target.setItem(k, v);
      copied++;
    }
  }
  // Write ldk_seed last so that if we're interrupted before this point, the
  // next load still sees an empty target and retries the full copy.
  if (seedValue !== null) {
    await target.setItem("ldk_seed", seedValue);
    copied++;
  }
  return copied;
}
