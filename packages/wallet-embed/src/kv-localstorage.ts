// KVStore (permission-store contract) over localStorage, namespaced so the widget's WebLN grants
// can't collide with other app-layer keys on the host origin.
import type { KVStore } from "@libre/wallet-core";

export function localStorageKV(prefix = "libre_embed:"): KVStore {
  return {
    async get(key) {
      try {
        return localStorage.getItem(prefix + key);
      } catch {
        return null; // private mode / storage disabled — grants just don't persist
      }
    },
    async set(key, value) {
      try {
        localStorage.setItem(prefix + key, value);
      } catch {
        /* best-effort */
      }
    },
  };
}
