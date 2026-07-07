import {
  KVStoreInterface,
  Result_CVec_u8ZIOErrorZ,
  Result_NoneIOErrorZ,
  Result_CVec_StrZIOErrorZ,
  IOError,
} from "lightningdevkit";
import { SecureStorageProvider, Logger } from "./index";

// Byte→hex lookup table (256 entries). The old `Array.from(bytes).map(...).join("")` allocated
// tens of millions of transient strings when encoding the ~20MB network graph on stop()/start()
// (seconds of GC jank on mobile). A table lookup + single join is ~10-50× faster, same output.
const BYTE_TO_HEX: string[] = Array.from({ length: 256 }, (_, b) => b.toString(16).padStart(2, "0"));

export function bytesToHex(bytes: Uint8Array): string {
  const out = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = BYTE_TO_HEX[bytes[i]];
  return out.join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Parse the persisted `ldk_seed` into its 32 bytes, throwing loudly on a malformed value.
 * The seed is always written as `bytesToHex(32 bytes)` (64 lowercase hex chars), so anything
 * else is corruption. `hexToBytes` would silently coerce non-hex to 0-bytes / truncate a short
 * string — deriving a DIFFERENT node identity from the same-length garbage and orphaning a
 * funded wallet. Failing here instead surfaces the corruption before any key is derived.
 */
export function parseSeedHex(seedHex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) {
    throw new Error(
      `Stored ldk_seed is malformed (expected 64 hex chars, got length ${seedHex.length}); refusing to derive keys from a corrupt seed`
    );
  }
  return hexToBytes(seedHex);
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
  private logger?: Logger;
  private cache: Map<string, Uint8Array> = new Map();
  private keys: Set<string> = new Set();
  private indexKey = "ldk_keys_index";
  private isLoaded = false;
  // Flips to false the moment a background persist (setItem/removeItem/index)
  // rejects. LDK's KVStore.write/remove are synchronous and we can't await the
  // durable commit before answering, so a fire-and-forget failure would
  // otherwise be invisible while LDK proceeds to revoke old commitment state on
  // the belief a monitor update persisted — the classic path to broadcasting a
  // stale channel state and losing funds. Once degraded, every subsequent
  // write/remove returns an IOError so LDK STOPS advancing channel state instead
  // of compounding on storage it can't trust.
  private persistenceHealthy = true;
  // Outstanding async commits (setItem/removeItem/index). flush() awaits these so a caller can
  // block channel-state advancement until the write is DURABLE (Layer C).
  private pending = new Set<Promise<unknown>>();

  constructor(storage: SecureStorageProvider, logger?: Logger) {
    this.storage = storage;
    this.logger = logger;
  }

  /** True while every persisted write is known to have committed. */
  isPersistenceHealthy(): boolean {
    return this.persistenceHealthy;
  }

  /** Resolve once every write/remove issued before this call has durably committed; reject if any
   *  failed OR if persistence is degraded. A degraded cache refuses writes synchronously (they never
   *  enter `pending`), so flush() MUST consult the health flag directly — otherwise a refused monitor
   *  write would be falsely reported durable and LDK would advance on state that never landed. */
  async flush(): Promise<void> {
    if (!this.persistenceHealthy) {
      throw new Error("StorageCache.flush: persistence degraded — writes are being refused");
    }
    const snapshot = Array.from(this.pending);
    const results = await Promise.allSettled(snapshot);
    const failed = results.filter((r) => r.status === "rejected").length;
    if (!this.persistenceHealthy || failed > 0) {
      throw new Error(
        `StorageCache.flush: ${!this.persistenceHealthy ? "persistence degraded" : `${failed} pending write(s) failed`}`,
      );
    }
  }

  private onPersistError(op: string, storeKey: string, err: unknown): void {
    this.persistenceHealthy = false;
    const msg = err instanceof Error ? err.message : String(err);
    this.logger?.error(
      `[StorageCache] Persist ${op} for "${storeKey}" FAILED — channel-state persistence is now degraded; refusing further writes: ${msg}`,
    );
  }

  private track(p: Promise<unknown>): void {
    this.pending.add(p);
    void p.then(
      () => this.pending.delete(p),
      () => this.pending.delete(p),
    );
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
        // A corrupt key index means we can't trust which monitors exist; clear
        // it and surface the problem rather than swallowing it silently.
        this.logger?.error(
          `[StorageCache] Corrupt "${this.indexKey}" — clearing key index: ${e instanceof Error ? e.message : String(e)}`,
        );
        this.keys.clear();
      }
    }
    this.isLoaded = true;
  }

  /**
   * Force a re-read of the key index + values from storage, discarding the in-memory snapshot.
   * `load()` is idempotent (no-ops once loaded), so it CANNOT pick up keys written out-of-band —
   * e.g. a VSS re-hydrate (importState) that writes channel_manager + monitor keys straight to
   * storage during start(). Without this, the cache keeps its stale pre-write (empty) view and the
   * monitors never load → the restored channel_manager fails to decode → force-close. Call this
   * after any direct-to-storage write the cache must then serve.
   */
  async reload(): Promise<void> {
    this.isLoaded = false;
    this.cache.clear();
    this.keys.clear();
    await this.load();
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
    if (!this.persistenceHealthy) {
      this.logger?.error(`[StorageCache] Refusing write for "${storeKey}" — persistence degraded.`);
      return Result_NoneIOErrorZ.constructor_err(IOError.LDKIOError_Other);
    }
    this.cache.set(storeKey, buf);

    if (!this.keys.has(storeKey)) {
      this.keys.add(storeKey);
      const ip = this.persistIndex();
      this.track(ip);
      ip.catch((e) => this.onPersistError("index", this.indexKey, e));
    }

    const hexVal = bytesToHex(buf);
    const wp = this.storage.setItem(storeKey, hexVal);
    this.track(wp);
    wp.catch((e) => this.onPersistError("write", storeKey, e));

    return Result_NoneIOErrorZ.constructor_ok();
  }

  remove(primary_namespace: string, secondary_namespace: string, key: string, lazy: boolean): Result_NoneIOErrorZ {
    const storeKey = getStorageKey(primary_namespace, secondary_namespace, key);
    if (!this.persistenceHealthy) {
      this.logger?.error(`[StorageCache] Refusing remove for "${storeKey}" — persistence degraded.`);
      return Result_NoneIOErrorZ.constructor_err(IOError.LDKIOError_Other);
    }
    this.cache.delete(storeKey);

    if (this.keys.has(storeKey)) {
      this.keys.delete(storeKey);
      const ip = this.persistIndex();
      this.track(ip);
      ip.catch((e) => this.onPersistError("index", this.indexKey, e));
    }

    const rp = this.storage.removeItem(storeKey);
    this.track(rp);
    rp.catch((e) => this.onPersistError("remove", storeKey, e));

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
