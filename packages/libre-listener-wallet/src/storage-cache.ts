import {
  KVStoreInterface,
  Result_CVec_u8ZIOErrorZ,
  Result_NoneIOErrorZ,
  Result_CVec_StrZIOErrorZ,
  IOError,
} from "lightningdevkit";
import { SecureStorageProvider } from "./index";

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function getStorageKey(primary: string, secondary: string, key: string): string {
  const parts: string[] = [];
  if (primary) parts.push(primary);
  if (secondary) parts.push(secondary);
  parts.push(key);
  return parts.join("/");
}

export class StorageCache implements KVStoreInterface {
  private storage: SecureStorageProvider;
  private cache: Map<string, Uint8Array> = new Map();
  private keys: Set<string> = new Set();
  private indexKey = "ldk_keys_index";
  private isLoaded = false;

  constructor(storage: SecureStorageProvider) {
    this.storage = storage;
  }

  async load(): Promise<void> {
    if (this.isLoaded) return;

    const indexStr = await this.storage.getItem(this.indexKey);
    if (indexStr) {
      try {
        const keyList = JSON.parse(indexStr) as string[];
        for (const key of keyList) {
          this.keys.add(key);
          const hexVal = await this.storage.getItem(key);
          if (hexVal !== null) {
            this.cache.set(key, hexToBytes(hexVal));
          }
        }
      } catch (e) {
        this.keys.clear();
      }
    }
    this.isLoaded = true;
  }

  private async persistIndex(): Promise<void> {
    const list = Array.from(this.keys);
    await this.storage.setItem(this.indexKey, JSON.stringify(list));
  }

  read(primary_namespace: string, secondary_namespace: string, key: string): Result_CVec_u8ZIOErrorZ {
    const storeKey = getStorageKey(primary_namespace, secondary_namespace, key);
    const cached = this.cache.get(storeKey);
    if (cached !== undefined) {
      return Result_CVec_u8ZIOErrorZ.constructor_ok(cached);
    }
    return Result_CVec_u8ZIOErrorZ.constructor_err(IOError.LDKIOError_NotFound);
  }

  write(primary_namespace: string, secondary_namespace: string, key: string, buf: Uint8Array): Result_NoneIOErrorZ {
    const storeKey = getStorageKey(primary_namespace, secondary_namespace, key);
    this.cache.set(storeKey, buf);
    
    if (!this.keys.has(storeKey)) {
      this.keys.add(storeKey);
      this.persistIndex().catch(() => {});
    }

    const hexVal = bytesToHex(buf);
    this.storage.setItem(storeKey, hexVal).catch(() => {});

    return Result_NoneIOErrorZ.constructor_ok();
  }

  remove(primary_namespace: string, secondary_namespace: string, key: string, lazy: boolean): Result_NoneIOErrorZ {
    const storeKey = getStorageKey(primary_namespace, secondary_namespace, key);
    this.cache.delete(storeKey);
    
    if (this.keys.has(storeKey)) {
      this.keys.delete(storeKey);
      this.persistIndex().catch(() => {});
    }

    this.storage.removeItem(storeKey).catch(() => {});

    return Result_NoneIOErrorZ.constructor_ok();
  }

  list(primary_namespace: string, secondary_namespace: string): Result_CVec_StrZIOErrorZ {
    // Build the namespace prefix. LDK enumerates with primary set (e.g. list("monitors", "")); the empty-primary branch is a defensive fallback with no current caller.
    const prefix = primary_namespace
      ? (secondary_namespace ? `${primary_namespace}/${secondary_namespace}/` : `${primary_namespace}/`)
      : (secondary_namespace ? `${secondary_namespace}/` : "");

    const matchedKeys: string[] = [];
    for (const storeKey of this.keys) {
      if (prefix === "") {
        if (!storeKey.includes("/")) {
          matchedKeys.push(storeKey);
        }
      } else if (storeKey.startsWith(prefix)) {
        const keyName = storeKey.substring(prefix.length);
        if (!keyName.includes("/")) {
          matchedKeys.push(keyName);
        }
      }
    }

    return Result_CVec_StrZIOErrorZ.constructor_ok(matchedKeys);
  }
}
