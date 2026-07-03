// Per-origin permission + spending-cap store for WebLN callers.
//
// This ports the model NwcManager already uses (per-caller identity, spendingLimitSats,
// spentTodaySats, daily reset, and — critically — per-caller request serialization so two
// concurrent payments can't both slip past the cap) but swaps the caller identity from a
// Nostr client pubkey to the page ORIGIN, and swaps Nostr-relay transport for extension
// messaging. Grants persist via an injected KV store (chrome.storage.local in the extension,
// an in-memory map in tests). The clock is injected so the daily-reset logic is testable.

export interface OriginGrant {
  origin: string;
  enabled: boolean;
  spendingLimitSats: number; // 0 = unlimited
  spentTodaySats: number;
  lastSpentTimestamp: number;
  createdAt: number;
}

export interface KVStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export class QuotaExceededError extends Error {
  constructor(public readonly origin: string, public readonly capSats: number) {
    super(`Daily spending limit of ${capSats} sats exceeded for ${origin}`);
    this.name = "QuotaExceededError";
  }
}

const GRANTS_KEY = "libre_webln_grants";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export class PermissionStore {
  private cache?: Record<string, OriginGrant>;
  // Per-origin serialization: charges for the same origin run strictly in sequence so the
  // check-and-debit is atomic even under concurrent page requests (the NWC requestChains trick).
  private chains: Map<string, Promise<unknown>> = new Map();

  constructor(private kv: KVStore, private now: () => number = () => Date.now()) {}

  private async load(): Promise<Record<string, OriginGrant>> {
    if (this.cache) return this.cache;
    const raw = await this.kv.get(GRANTS_KEY);
    this.cache = raw ? (JSON.parse(raw) as Record<string, OriginGrant>) : {};
    return this.cache;
  }

  private async persist(): Promise<void> {
    await this.kv.set(GRANTS_KEY, JSON.stringify(this.cache ?? {}));
  }

  async getGrant(origin: string): Promise<OriginGrant | undefined> {
    return (await this.load())[origin];
  }

  async listGrants(): Promise<OriginGrant[]> {
    return Object.values(await this.load());
  }

  async isEnabled(origin: string): Promise<boolean> {
    const g = await this.getGrant(origin);
    return !!g?.enabled;
  }

  // Create or update a grant (the user just approved this origin in the popup).
  async grant(origin: string, opts: { spendingLimitSats: number }): Promise<OriginGrant> {
    const grants = await this.load();
    const existing = grants[origin];
    const g: OriginGrant = existing
      ? { ...existing, enabled: true, spendingLimitSats: opts.spendingLimitSats }
      : {
          origin,
          enabled: true,
          spendingLimitSats: opts.spendingLimitSats,
          spentTodaySats: 0,
          lastSpentTimestamp: this.now(),
          createdAt: this.now(),
        };
    grants[origin] = g;
    await this.persist();
    return g;
  }

  async revoke(origin: string): Promise<void> {
    const grants = await this.load();
    if (grants[origin]) {
      delete grants[origin];
      await this.persist();
    }
  }

  // Serialize an operation per origin so cap check-and-debit can't interleave.
  private serialize<T>(origin: string, op: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(origin) ?? Promise.resolve();
    const next = prev.then(op, op);
    // Keep the chain alive but don't leak rejections into the next link's scheduling.
    this.chains.set(
      origin,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    return next;
  }

  private resetIfNewDay(g: OriginGrant): void {
    if (this.now() - g.lastSpentTimestamp >= ONE_DAY_MS) {
      g.spentTodaySats = 0;
      g.lastSpentTimestamp = this.now();
    }
  }

  // Atomically verify `amountSats` fits under the origin's daily cap and debit it. Throws
  // QuotaExceededError (leaving spend untouched) if it would exceed. A 0/unlimited cap always
  // passes. Concurrent calls for the same origin are serialized, so two payments can't both
  // pass a check that only one should.
  async chargeIfWithinCap(origin: string, amountSats: number): Promise<void> {
    return this.serialize(origin, async () => {
      const grants = await this.load();
      const g = grants[origin];
      if (!g || !g.enabled) throw new Error(`Origin not authorized: ${origin}`);
      this.resetIfNewDay(g);
      if (g.spendingLimitSats > 0 && g.spentTodaySats + amountSats > g.spendingLimitSats) {
        // Persist any daily-reset that happened above, but do NOT debit.
        await this.persist();
        throw new QuotaExceededError(origin, g.spendingLimitSats);
      }
      g.spentTodaySats += amountSats;
      g.lastSpentTimestamp = this.now();
      await this.persist();
    });
  }

  // Refund a previously-charged amount (e.g. the payment failed to settle). Best-effort.
  async refund(origin: string, amountSats: number): Promise<void> {
    return this.serialize(origin, async () => {
      const grants = await this.load();
      const g = grants[origin];
      if (!g) return;
      g.spentTodaySats = Math.max(0, g.spentTodaySats - amountSats);
      await this.persist();
    });
  }
}
