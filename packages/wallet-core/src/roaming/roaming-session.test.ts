import { describe, it, expect, vi } from "vitest";
import { RoamingLease, type LeaseStore } from "./drive-lease";
import { RoamingSession, type RoamingPorts, type RoamingViewState } from "./roaming-session";
import type { RoamingLeaseRecord } from "./roaming-policy";

const NOW = 1_700_000_000_000;

// Shared fake Drive: one lease record + one backup file, like the real appDataFolder.
class FakeDrive {
  lease: RoamingLeaseRecord | null = null;
  backup: string | null = null; // "envelope:<version>" — verify parses it
  backupModified: number | null = null;
  down = false;
  store(): LeaseStore {
    return {
      read: async () => {
        if (this.down) throw new Error("drive down");
        return this.lease ? { ...this.lease } : null;
      },
      write: async (r) => {
        if (this.down) throw new Error("drive down");
        this.lease = { ...r };
      },
    };
  }
}

// Fake local wallet + controller for ONE origin.
class FakeWallet {
  seedHex: string | null = null;
  stateVersion = 0;
  running = false;
  startCalls = 0;
  stopCalls = 0;
  restoreCalls: string[] = [];
  flushCalls = 0;
}

function makeSession(opts: {
  drive: FakeDrive;
  wallet: FakeWallet;
  origin: string;
  token: string;
  secretForBackup?: string; // the secret that decrypts drive.backup
  clock?: { t: number };
}) {
  const states: RoamingViewState[] = [];
  const { drive, wallet } = opts;
  const clock = opts.clock ?? { t: NOW };
  const now = () => clock.t;
  // delay() advances the fake clock — polls/timeouts terminate deterministically.
  const tick = async (ms: number) => {
    clock.t += ms;
  };
  const ports: RoamingPorts = {
    readLocal: async () => ({ seedPresent: !!wallet.seedHex, stateVersion: wallet.stateVersion, seedHex: wallet.seedHex }),
    fetchBackup: async () => drive.backup,
    verifyEnvelope: async (envelope, secret) => {
      const m = /^envelope:(\d+)$/.exec(envelope);
      const good = m && (secret === (opts.secretForBackup ?? "seed-hex") || secret === wallet.seedHex);
      return good ? { ok: true, stateVersion: parseInt(m![1], 10) } : { ok: false };
    },
    backupModifiedTime: async () => drive.backupModified,
    startNode: async () => {
      wallet.startCalls++;
      wallet.running = true;
    },
    stopNode: async () => {
      wallet.stopCalls++;
      wallet.running = false;
    },
    restore: async (envelope, secret) => {
      wallet.restoreCalls.push(envelope + "|" + secret);
      const m = /^envelope:(\d+)$/.exec(envelope);
      wallet.seedHex = secret;
      wallet.stateVersion = m ? parseInt(m[1], 10) : 0;
      wallet.running = true; // controller.restoreWallet starts the node
    },
    flushBackup: async () => {
      wallet.flushCalls++;
      drive.backup = `envelope:${wallet.stateVersion}`;
      drive.backupModified = now();
      return wallet.stateVersion;
    },
  };
  const lease = new RoamingLease(drive.store(), {
    ownerToken: opts.token,
    origin: opts.origin,
    getStateVersion: () => wallet.stateVersion,
    now,
    delay: tick,
    random: () => 0,
  });
  const session = new RoamingSession(lease, ports, (s) => states.push(s), {
    now,
    delay: tick,
    confirmReadMs: 0,
    takeoverWaitMs: 90_000,
    takeoverPollMs: 5_000,
  });
  return { session, lease, states, ports, clock };
}

function liveLease(over: Partial<RoamingLeaseRecord> = {}): RoamingLeaseRecord {
  return {
    v: 1,
    owner: "tok-a",
    origin: "https://a.example",
    acquiredAt: NOW - 30_000,
    expiresAt: NOW + 60_000,
    seq: 5,
    heartbeatStateVersion: 40,
    phase: "live",
    ...over,
  };
}

describe("RoamingSession.boot", () => {
  it("fresh origin + backup → need-secret, then restore + run on the right secret", async () => {
    const drive = new FakeDrive();
    drive.backup = "envelope:40";
    const wallet = new FakeWallet();
    const { session, states } = makeSession({ drive, wallet, origin: "https://b.example", token: "tok-b" });

    expect((await session.boot()).view).toBe("need-secret");
    // wrong secret → stays on need-secret, no restore attempted
    expect((await session.submitSecret("wrong")).view).toBe("need-secret");
    expect(wallet.restoreCalls.length).toBe(0);
    // right secret → restore, node running, lease heartbeating
    expect((await session.submitSecret("seed-hex")).view).toBe("running");
    expect(wallet.restoreCalls.length).toBe(1);
    expect(wallet.running).toBe(true);
    expect(drive.lease?.owner).toBe("tok-b");
    expect(states.map((s) => s.view)).toContain("starting");
  });

  it("fresh origin + NO backup → setup-needed (creation lives in the wallet app)", async () => {
    const drive = new FakeDrive();
    const wallet = new FakeWallet();
    const { session } = makeSession({ drive, wallet, origin: "https://b.example", token: "tok-b" });
    expect((await session.boot()).view).toBe("setup-needed");
    expect(wallet.startCalls).toBe(0);
  });

  it("local wallet present → starts the node (controller guards own the rest)", async () => {
    const drive = new FakeDrive();
    drive.backup = "envelope:42";
    const wallet = new FakeWallet();
    wallet.seedHex = "seed-hex";
    wallet.stateVersion = 42;
    const { session } = makeSession({ drive, wallet, origin: "https://b.example", token: "tok-b" });
    expect((await session.boot()).view).toBe("running");
    expect(wallet.startCalls).toBe(1);
  });

  it("live foreign lease → blocked, and NOTHING is written to the lease file", async () => {
    const drive = new FakeDrive();
    drive.lease = liveLease();
    const wallet = new FakeWallet();
    const { session } = makeSession({ drive, wallet, origin: "https://b.example", token: "tok-b" });
    const s = await session.boot();
    expect(s).toMatchObject({ view: "blocked", origin: "https://a.example" });
    expect(drive.lease.owner).toBe("tok-a"); // untouched — peek only
  });

  it("crashed holder whose flush never landed → halt-version-gap, not a stale restore", async () => {
    const drive = new FakeDrive();
    drive.lease = liveLease({ expiresAt: NOW - 1, heartbeatStateVersion: 50 }); // crashed at v50
    drive.backup = "envelope:42"; // Drive only has v42
    const wallet = new FakeWallet();
    const { session } = makeSession({ drive, wallet, origin: "https://b.example", token: "tok-b" });
    expect((await session.boot()).view).toBe("need-secret");
    const s = await session.submitSecret("seed-hex"); // gap only detectable after decrypt
    expect(s).toMatchObject({ view: "halted", reason: "version-gap" });
    expect(wallet.restoreCalls.length).toBe(0); // the stale restore never happened
  });

  it("Drive unreachable at boot → paused (fail closed), no node", async () => {
    const drive = new FakeDrive();
    drive.down = true;
    const wallet = new FakeWallet();
    wallet.seedHex = "seed-hex";
    const { session } = makeSession({ drive, wallet, origin: "https://b.example", token: "tok-b" });
    expect(await session.boot()).toEqual({ view: "paused", reason: "drive-unreachable" });
    expect(wallet.startCalls).toBe(0);
  });
});

describe("RoamingSession takeover (Move wallet here)", () => {
  it("claims over a live holder, proceeds on its handoff ack, restores at the acked version", async () => {
    const drive = new FakeDrive();
    drive.lease = liveLease({ heartbeatStateVersion: 50 });
    drive.backup = "envelope:42"; // holder hasn't flushed v50 yet
    const wallet = new FakeWallet();
    const clock = { t: NOW };
    const { session, ports } = makeSession({ drive, wallet, origin: "https://b.example", token: "tok-b", clock });

    expect((await session.boot()).view).toBe("blocked");

    // Simulate the holder: after our claim, its heartbeat sees tok-b, stops, flushes v50, acks.
    // Hooked into the takeover poll's own probe (the fake-clock loop never yields to macrotasks).
    let probes = 0;
    const realProbe = ports.backupModifiedTime;
    ports.backupModifiedTime = async () => {
      if (++probes === 2) {
        drive.backup = "envelope:50";
        drive.backupModified = clock.t + 1;
        drive.lease = { ...drive.lease!, handoffAck: { from: "tok-a", flushedVersion: 50, at: clock.t } };
      }
      return realProbe();
    };
    const s = await session.moveHere();
    expect(s.view).toBe("need-secret"); // fresh origin still needs the secret
    const after = await session.submitSecret("seed-hex");
    expect(after.view).toBe("running");
    expect(wallet.stateVersion).toBe(50); // restored the FLUSHED version, not the stale v42
  });

  it("holder dead (no ack, no flush) → proceeds on timeout, then the gap check halts", async () => {
    const drive = new FakeDrive();
    drive.lease = liveLease({ heartbeatStateVersion: 50 });
    drive.backup = "envelope:42";
    const wallet = new FakeWallet();
    const { session } = makeSession({ drive, wallet, origin: "https://b.example", token: "tok-b" });
    expect((await session.boot()).view).toBe("blocked");
    // The dead holder never acks/flushes — the advancing poll clock reaches the 90s window.
    const s = await session.moveHere();
    expect(s.view).toBe("need-secret");
    const after = await session.submitSecret("seed-hex");
    expect(after).toMatchObject({ view: "halted", reason: "version-gap" });
  });
});

describe("RoamingSession eviction (the holder side)", () => {
  it("on eviction: stops the node, flushes (ahead of Drive), acks, shows moved-away", async () => {
    const drive = new FakeDrive();
    drive.backup = "envelope:40";
    const wallet = new FakeWallet();
    wallet.seedHex = "seed-hex";
    wallet.stateVersion = 45; // we're ahead of the backup
    const { session, lease } = makeSession({ drive, wallet, origin: "https://a.example", token: "tok-a" });
    expect((await session.boot()).view).toBe("running");

    // Another origin claims the lease...
    drive.lease = liveLease({ owner: "tok-b", origin: "https://b.example", seq: 99 });
    // ...and our next heartbeat tick notices.
    await lease.tick({
      onEvicted: () => {}, // startHeartbeat installed its own handlers; drive the real path:
      onOutageFence: () => {},
    });
    // The interval handler is private; call the tick through the session's public surface instead:
    // simulate by invoking the same handlers startHeartbeat wired — via a direct tick with the
    // session's handlers is not exposed, so assert through state after a manual eviction cycle.
    // (The lease unit tests already pin tick() semantics; here we drive onEvicted directly.)
    await (session as unknown as { onEvicted: (c: RoamingLeaseRecord | null) => Promise<void> }).onEvicted(drive.lease);

    expect(wallet.stopCalls).toBeGreaterThan(0);
    expect(wallet.flushCalls).toBe(1); // ahead → flushed
    expect(drive.backup).toBe("envelope:45");
    expect(drive.lease?.handoffAck).toMatchObject({ from: "tok-a", flushedVersion: 45 });
    expect(drive.lease?.owner).toBe("tok-b"); // never touched the claimant's ownership
    expect(session.current()).toMatchObject({ view: "moved-away", origin: "https://b.example" });
  });

  it("on eviction with a Drive copy already current → acks WITHOUT uploading (never clobber the successor)", async () => {
    const drive = new FakeDrive();
    drive.backup = "envelope:45";
    const wallet = new FakeWallet();
    wallet.seedHex = "seed-hex";
    wallet.stateVersion = 45;
    const { session } = makeSession({ drive, wallet, origin: "https://a.example", token: "tok-a" });
    expect((await session.boot()).view).toBe("running");
    drive.lease = liveLease({ owner: "tok-b", origin: "https://b.example" });
    await (session as unknown as { onEvicted: (c: RoamingLeaseRecord | null) => Promise<void> }).onEvicted(drive.lease);
    expect(wallet.flushCalls).toBe(0);
    expect(drive.lease?.handoffAck).toMatchObject({ from: "tok-a", flushedVersion: 45 });
  });
});

describe("RoamingSession.dispose", () => {
  it("clean shutdown: stop, final flush, lease released", async () => {
    const drive = new FakeDrive();
    drive.backup = "envelope:42";
    const wallet = new FakeWallet();
    wallet.seedHex = "seed-hex";
    wallet.stateVersion = 43;
    const { session } = makeSession({ drive, wallet, origin: "https://a.example", token: "tok-a" });
    expect((await session.boot()).view).toBe("running");
    await session.dispose();
    expect(wallet.stopCalls).toBe(1);
    expect(drive.backup).toBe("envelope:43");
    expect(drive.lease?.phase).toBe("released");
    expect(session.current().view).toBe("stopped");
  });
});

describe("full A→B→A roam cycle over one fake Drive", () => {
  it("moves the wallet between two origins with no stale start", async () => {
    const drive = new FakeDrive();
    // Origin A: wallet lives here, running.
    const walletA = new FakeWallet();
    walletA.seedHex = "seed-hex";
    walletA.stateVersion = 10;
    const a = makeSession({ drive, wallet: walletA, origin: "https://a.example", token: "tok-a" });
    expect((await a.session.boot()).view).toBe("running");
    await a.session.dispose(); // user closes tab A cleanly → flush v10 + release

    // Origin B (fresh): restore + run, then advance state to v20 and hand off cleanly.
    const walletB = new FakeWallet();
    const b = makeSession({ drive, wallet: walletB, origin: "https://b.example", token: "tok-b" });
    expect((await b.session.boot()).view).toBe("need-secret");
    expect((await b.session.submitSecret("seed-hex")).view).toBe("running");
    expect(walletB.stateVersion).toBe(10);
    walletB.stateVersion = 20; // payments happen on B
    await b.session.dispose();

    // Back to A: stale local (v10) — the session starts the node; the CONTROLLER's own
    // backup-ahead guard handles the silent self-heal (out of scope for the fake).
    const a2 = makeSession({ drive, wallet: walletA, origin: "https://a.example", token: "tok-a2" });
    expect((await a2.session.boot()).view).toBe("running");
    expect(drive.backup).toBe("envelope:20"); // B's state survived the round trip
    expect(drive.lease?.owner).toBe("tok-a2");
  });
});

describe("running holder loses Drive for longer than the lease → self-fence", () => {
  it("stops the node instead of running unfenced", async () => {
    const drive = new FakeDrive();
    drive.backup = "envelope:42";
    const wallet = new FakeWallet();
    wallet.seedHex = "seed-hex";
    wallet.stateVersion = 42;
    const clock = { t: NOW };
    const { session, lease } = makeSession({ drive, wallet, origin: "https://a.example", token: "tok-a", clock });
    expect((await session.boot()).view).toBe("running");

    drive.down = true;
    const fence = vi.fn(async () => {
      await (session as unknown as { selfFence: (w: string) => Promise<void> }).selfFence("drive-outage");
    });
    expect(await lease.tick({ onEvicted: () => {}, onOutageFence: fence })).toBe("failed");
    clock.t += 121_000;
    expect(await lease.tick({ onEvicted: () => {}, onOutageFence: fence })).toBe("fenced");
    await new Promise((r) => setTimeout(r, 0));
    expect(wallet.running).toBe(false);
    expect(session.current()).toEqual({ view: "paused", reason: "drive-unreachable" });
  });
});
