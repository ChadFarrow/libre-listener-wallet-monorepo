import type { KVStore } from "./permission-store";

// KVStore backed by chrome.storage.local. Kept separate from the wallet's IndexedDB — permission
// grants are control-plane metadata, not wallet state, and live only in the extension origin.
export const chromeKV: KVStore = {
  async get(key: string): Promise<string | null> {
    const out = await chrome.storage.local.get(key);
    const v = out[key];
    return typeof v === "string" ? v : null;
  },
  async set(key: string, value: string): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
  },
};
