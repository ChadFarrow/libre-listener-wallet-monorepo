import type { SecureStorageProvider, Logger } from "./index";

// Forward-only, on-device channel-close history. Mirrors payment-log.ts exactly:
// ONE non-critical key per record (`close_<channelId>`), unbounded, never in the
// backup, rehydrated at start() / first read. The LDK `instanceof` event demux stays
// in index.ts (minification-safe); this class is unit-testable without a node.

export const CLOSE_KEY_PREFIX = "close_";
const closeKey = (channelId: string): string => `${CLOSE_KEY_PREFIX}${channelId}`;

export type ChannelCloseReason =
  | "counterparty-force-closed"
  | "we-force-closed"
  | "force-closed" // a commitment tx confirmed on-chain — either side may have closed
  | "cooperative"
  | "outdated-manager"
  | "other";

export interface ChannelCloseRecord {
  channelId: string;
  counterpartyNodeId?: string;
  capacitySat?: number;
  reason: ChannelCloseReason;
  closedAt: number; // ms epoch
}

export interface CloseLoggerDeps {
  storage: SecureStorageProvider;
  logger?: Logger;
}

export class CloseLogger {
  private storage: SecureStorageProvider;
  private logger?: Logger;
  private records: Map<string, ChannelCloseRecord> = new Map();
  private loaded = false;

  constructor(deps: CloseLoggerDeps) {
    this.storage = deps.storage;
    this.logger = deps.logger;
  }

  /** Rehydrate from every persisted `close_*` key. Best-effort. */
  async load(): Promise<void> {
    this.loaded = true;
    if (!this.storage.keys) {
      this.logger?.warn?.("[CloseLog] storage has no keys() — close history disabled for this provider");
      return;
    }
    try {
      const keys = (await this.storage.keys()).filter((k) => k.startsWith(CLOSE_KEY_PREFIX));
      for (const key of keys) {
        try {
          const raw = await this.storage.getItem(key);
          if (!raw) continue;
          const rec = JSON.parse(raw) as ChannelCloseRecord;
          if (rec && typeof rec.channelId === "string") this.records.set(rec.channelId, rec);
        } catch (e) {
          this.logger?.warn?.(`[CloseLog] skipping unreadable record ${key}: ${e instanceof Error ? e.message : e}`);
        }
      }
    } catch (e) {
      this.logger?.error?.(`[CloseLog] load failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Record (or update) a channel close. LDK may re-emit the event on restart — upsert by id. */
  record(rec: ChannelCloseRecord): void {
    this.records.set(rec.channelId, rec);
    // Fire-and-forget: a persist failure must never break event handling.
    void this.storage.setItem(closeKey(rec.channelId), JSON.stringify(rec)).catch((e) => {
      this.logger?.error?.(`[CloseLog] persist ${rec.channelId} failed: ${e instanceof Error ? e.message : e}`);
    });
  }

  /** Newest-first snapshot. */
  getRecords(): ChannelCloseRecord[] {
    return [...this.records.values()].sort((a, b) => b.closedAt - a.closedAt);
  }

  isLoaded(): boolean {
    return this.loaded;
  }
}
