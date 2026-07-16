import { describe, it, expect, vi } from "vitest";
import {
  RoamingLease,
  RoamingLeaseHeldError,
  LeaseUnreachableError,
  driveLeaseStore,
  leaseFilename,
  type LeaseStore,
} from "./drive-lease";
import type { RoamingLeaseRecord } from "./roaming-policy";

// In-memory LeaseStore with failure injection and a serialized write log — the deterministic
// stand-in for the Drive file (last write wins, like Drive's PATCH).
class FakeStore implements LeaseStore {
  record: RoamingLeaseRecord | null = null;
  failReads = 0;
  failWrites = 0;
  writes: RoamingLeaseRecord[] = [];
  async read(): Promise<RoamingLeaseRecord | null> {
    if (this.failReads > 0) {
      this.failReads--;
      throw new Error("drive down");
    }
    return this.record ? { ...this.record } : null;
  }
  async write(r: RoamingLeaseRecord): Promise<void> {
    if (this.failWrites > 0) {
      this.failWrites--;
      throw new Error("drive down");
    }
    this.record = { ...r };
    this.writes.push({ ...r });
  }
  syncIssuable = true;
  writeSyncKeepalive(r: RoamingLeaseRecord): boolean {
    if (!this.syncIssuable) return false;
    this.record = { ...r };
    this.writes.push({ ...r });
    return true;
  }
}

const NOW = 1_700_000_000_000;

function makeLease(store: LeaseStore, over: Partial<ConstructorParameters<typeof RoamingLease>[1]> = {}) {
  return new RoamingLease(store, {
    ownerToken: "tok-b",
    origin: "https://b.example",
    appName: "demo",
    getStateVersion: () => 7,
    now: () => NOW,
    delay: async () => {},
    random: () => 0,
    ...over,
  });
}

function foreignLive(over: Partial<RoamingLeaseRecord> = {}): RoamingLeaseRecord {
  return {
    v: 1,
    owner: "tok-a",
    origin: "https://a.example",
    acquiredAt: NOW - 50_000,
    expiresAt: NOW + 60_000,
    seq: 4,
    heartbeatStateVersion: 41,
    phase: "live",
    ...over,
  };
}

describe("RoamingLease.acquire", () => {
  it("claims an absent lease and read-back-verifies", async () => {
    const store = new FakeStore();
    const lease = makeLease(store);
    const r = await lease.acquire();
    expect(r.owner).toBe("tok-b");
    expect(r.origin).toBe("https://b.example");
    expect(r.heartbeatStateVersion).toBe(7);
    expect(store.record?.owner).toBe("tok-b");
  });

  it("refuses a live foreign lease without takeover", async () => {
    const store = new FakeStore();
    store.record = foreignLive();
    await expect(makeLease(store).acquire()).rejects.toMatchObject({
      code: "ROAMING_LEASE_HELD",
      origin: "https://a.example",
    });
    expect(store.writes.length).toBe(0); // never wrote over the live holder
  });

  it("claims OVER a live foreign lease with takeover:true", async () => {
    const store = new FakeStore();
    store.record = foreignLive();
    const r = await makeLease(store).acquire({ takeover: true });
    expect(r.owner).toBe("tok-b");
    expect(r.seq).toBe(5); // bumped over the holder's record
  });

  it("claims an expired foreign lease without takeover", async () => {
    const store = new FakeStore();
    store.record = foreignLive({ expiresAt: NOW - 1 });
    const r = await makeLease(store).acquire();
    expect(r.owner).toBe("tok-b");
  });

  it("backs off when a concurrent claimant's write lands after ours (read-back loses)", async () => {
    const store = new FakeStore();
    const lease = makeLease(store, {
      // simulate the race: during our settle delay, a third origin's write lands last
      delay: async () => {
        store.record = foreignLive({ owner: "tok-c", origin: "https://c.example", seq: 9 });
      },
    });
    await expect(lease.acquire()).rejects.toMatchObject({ code: "ROAMING_LEASE_HELD", origin: "https://c.example" });
  });

  it("FAILS CLOSED when the store is unreachable", async () => {
    const store = new FakeStore();
    store.failReads = 1;
    await expect(makeLease(store).acquire()).rejects.toBeInstanceOf(LeaseUnreachableError);
    const store2 = new FakeStore();
    store2.failWrites = 1;
    await expect(makeLease(store2).acquire()).rejects.toBeInstanceOf(LeaseUnreachableError);
  });
});

describe("RoamingLease heartbeat", () => {
  it("renews with a fresh expiry and current state version", async () => {
    const store = new FakeStore();
    const lease = makeLease(store, { getStateVersion: () => 12 });
    await lease.acquire();
    const result = await lease.tick({ onEvicted: () => {}, onOutageFence: () => {} });
    expect(result).toBe("renewed");
    expect(store.record?.heartbeatStateVersion).toBe(12);
    expect(store.record?.expiresAt).toBe(NOW + 120_000);
  });

  it("read-first: a claimant's record triggers eviction, never a blind overwrite", async () => {
    const store = new FakeStore();
    const lease = makeLease(store);
    await lease.acquire();
    store.record = foreignLive({ owner: "tok-claimant", origin: "https://c.example" });
    const onEvicted = vi.fn();
    const result = await lease.tick({ onEvicted, onOutageFence: () => {} });
    expect(result).toBe("evicted");
    expect(onEvicted).toHaveBeenCalledWith(expect.objectContaining({ owner: "tok-claimant" }));
    expect(store.record?.owner).toBe("tok-claimant"); // untouched
  });

  it("tolerates transient failures, then self-fences once the outage outlives the lease", async () => {
    const store = new FakeStore();
    let now = NOW;
    const lease = makeLease(store, { now: () => now });
    await lease.acquire();
    const onOutageFence = vi.fn();
    store.failReads = 99;
    expect(await lease.tick({ onEvicted: () => {}, onOutageFence })).toBe("failed");
    now += 60_000;
    expect(await lease.tick({ onEvicted: () => {}, onOutageFence })).toBe("failed");
    now += 61_000; // failures now span > 120s lease window
    expect(await lease.tick({ onEvicted: () => {}, onOutageFence })).toBe("fenced");
    expect(onOutageFence).toHaveBeenCalledOnce();
    // A fenced lease stays fenced (no zombie resumption).
    expect(await lease.tick({ onEvicted: () => {}, onOutageFence })).toBe("fenced");
  });

  it("a successful renewal clears the failure window", async () => {
    const store = new FakeStore();
    let now = NOW;
    const lease = makeLease(store, { now: () => now });
    await lease.acquire();
    store.failReads = 1;
    await lease.tick({ onEvicted: () => {}, onOutageFence: () => {} });
    now += 100_000;
    expect(await lease.tick({ onEvicted: () => {}, onOutageFence: () => {} })).toBe("renewed");
    now += 121_000;
    store.failReads = 1;
    // fresh outage — must NOT count from the old failure
    expect(await lease.tick({ onEvicted: () => {}, onOutageFence: () => {} })).toBe("failed");
  });
});

describe("RoamingLease handoff + release", () => {
  it("writeHandoffAck merges the ack without touching the claimant's ownership", async () => {
    const store = new FakeStore();
    const lease = makeLease(store, { ownerToken: "tok-a", getStateVersion: () => 50 });
    store.record = foreignLive({ owner: "tok-claimant", origin: "https://c.example", seq: 10 });
    await lease.writeHandoffAck(50);
    expect(store.record?.owner).toBe("tok-claimant");
    expect(store.record?.seq).toBe(11);
    expect(store.record?.handoffAck).toEqual({ from: "tok-a", flushedVersion: 50, at: NOW });
  });

  it("release marks OUR lease released; leaves a foreign lease alone", async () => {
    const store = new FakeStore();
    const lease = makeLease(store);
    await lease.acquire();
    await lease.release({ localStateVersion: 7, flushedVersion: 7 });
    expect(store.record?.phase).toBe("released");
    expect(store.record?.expiresAt).toBe(NOW);

    const store2 = new FakeStore();
    store2.record = foreignLive();
    await makeLease(store2).release({ localStateVersion: 7, flushedVersion: 7 });
    expect(store2.record?.phase).toBe("live"); // untouched
  });

  // "released" is now the strongest proof a successor has. Claiming it while our last flush is
  // behind our local state is a LIE that hands the next origin a stale backup to restore.
  it("release refuses to claim `released` when the backup is behind our local state", async () => {
    const store = new FakeStore();
    const lease = makeLease(store);
    await lease.acquire();
    await lease.release({ localStateVersion: 51, flushedVersion: 42 }); // flush didn't land
    expect(store.record?.phase).toBe("live"); // honest: we have unflushed state
    expect(store.record?.heartbeatStateVersion).toBe(51); // and we say how far we really got
  });
});

describe("RoamingLease.releaseSyncKeepalive (the pagehide path)", () => {
  it("marks released ONLY when the backup provably holds everything we have", async () => {
    const store = new FakeStore();
    const lease = makeLease(store);
    await lease.acquire();
    expect(lease.releaseSyncKeepalive({ localStateVersion: 51, flushedVersion: 51 })).toBe(true);
    expect(store.record?.phase).toBe("released");
    expect(store.record?.expiresAt).toBe(NOW); // never extend a lease we're abandoning
  });

  it("stays live at our TRUE final version when a flush is still pending", async () => {
    // The successor then has honest evidence of the gap instead of a stale backup to restore.
    const store = new FakeStore();
    const lease = makeLease(store);
    await lease.acquire();
    expect(lease.releaseSyncKeepalive({ localStateVersion: 51, flushedVersion: 42 })).toBe(true);
    expect(store.record?.phase).toBe("live");
    expect(store.record?.heartbeatStateVersion).toBe(51);
  });

  it("reports false when nothing could be issued — never a silent success", async () => {
    const store = new FakeStore();
    const lease = makeLease(store);
    // Never wrote a record this page-life → no cached id to PATCH.
    expect(lease.releaseSyncKeepalive({ localStateVersion: 1, flushedVersion: 1 })).toBe(false);
    await lease.acquire();
    store.syncIssuable = false; // e.g. token gone
    expect(lease.releaseSyncKeepalive({ localStateVersion: 1, flushedVersion: 1 })).toBe(false);
  });

  it("carries the unproven predecessor through the final write", async () => {
    // Dying mid-takeover must not launder away who we took the wallet from.
    const store = new FakeStore();
    store.record = foreignLive({ owner: "tok-a", origin: "https://a.example", heartbeatStateVersion: 20 });
    const lease = makeLease(store, { getStateVersion: () => 0 });
    await lease.acquire({ takeover: true });
    lease.releaseSyncKeepalive({ localStateVersion: 0, flushedVersion: 0 });
    expect(store.record?.unprovenPredecessor?.advertisedVersion).toBe(20);
  });
});

describe("driveLeaseStore adapter", () => {
  it("serializes to the pinned per-network filename and parses defensively", async () => {
    const files = new Map<string, string>();
    const store = driveLeaseStore("mainnet", {
      readFile: async (n) => (files.has(n) ? { contents: files.get(n)! } : null),
      writeFile: async (n, c) => void files.set(n, c),
    });
    expect(await store.read()).toBeNull();
    await store.write(foreignLive());
    expect(files.has(leaseFilename("mainnet"))).toBe(true);
    expect((await store.read())?.owner).toBe("tok-a");
    files.set(leaseFilename("mainnet"), "corrupt");
    expect(await store.read()).toBeNull();
  });
});
