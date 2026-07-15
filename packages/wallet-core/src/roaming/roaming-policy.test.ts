import { describe, it, expect } from "vitest";
import {
  leaseState,
  roamingBootDecision,
  heartbeatDecision,
  shouldSelfFenceOnOutage,
  buildLeaseRecord,
  takeoverMayProceed,
  parseLeaseRecord,
  ROAMING_LEASE_MS,
  type RoamingLeaseRecord,
} from "./roaming-policy";

const NOW = 1_700_000_000_000;

function lease(over: Partial<RoamingLeaseRecord> = {}): RoamingLeaseRecord {
  return {
    v: 1,
    owner: "other-token",
    origin: "https://a.example",
    acquiredAt: NOW - 10_000,
    expiresAt: NOW + 60_000,
    seq: 3,
    heartbeatStateVersion: 42,
    phase: "live",
    ...over,
  };
}

describe("leaseState", () => {
  it("classifies absent / ours / foreign live / foreign expired / released", () => {
    expect(leaseState(null, "me", NOW)).toBe("absent");
    expect(leaseState(lease({ owner: "me" }), "me", NOW)).toBe("ours");
    expect(leaseState(lease(), "me", NOW)).toBe("foreignLive");
    expect(leaseState(lease({ expiresAt: NOW - 1 }), "me", NOW)).toBe("foreignExpired");
    expect(leaseState(lease({ phase: "released" }), "me", NOW)).toBe("released");
  });
});

describe("roamingBootDecision", () => {
  const base = {
    ownerToken: "me",
    now: NOW,
    backupPresent: true,
    backupStateVersion: 42,
    localSeedPresent: true,
    localStateVersion: 42,
  };

  it("live foreign lease → blocked with the holder's origin", () => {
    const d = roamingBootDecision({ ...base, lease: lease() });
    expect(d).toEqual({ action: "blocked", origin: "https://a.example", expiresAt: NOW + 60_000 });
  });

  it("expired foreign lease advertising MORE state than the backup → halt-version-gap", () => {
    // Origin A crashed without its final flush: lease says v50, backup only has v42, we have v40.
    const d = roamingBootDecision({
      ...base,
      lease: lease({ expiresAt: NOW - 1, heartbeatStateVersion: 50 }),
      localStateVersion: 40,
    });
    expect(d).toEqual({ action: "halt-version-gap", staleOrigin: "https://a.example", missingVersions: 8 });
  });

  it("version gap does NOT halt the origin that holds the missing state locally", () => {
    // We ARE origin A reopening: local v50 ≥ advertised v50 — start (our flush catches Drive up).
    const d = roamingBootDecision({
      ...base,
      lease: lease({ expiresAt: NOW - 1, heartbeatStateVersion: 50 }),
      localStateVersion: 50,
    });
    expect(d.action).toBe("start");
  });

  it("with leaseClaimed, a live pre-claim record never re-blocks — it's gap evidence only", () => {
    // Takeover: we claimed over a live holder; deciding again with the PRE-claim record must
    // route by local/backup state (restore here), not bounce back to blocked.
    const d = roamingBootDecision({
      ...base,
      lease: lease({ heartbeatStateVersion: 42 }),
      leaseClaimed: true,
      localSeedPresent: false,
      localStateVersion: 0,
      backupStateVersion: null,
    });
    expect(d.action).toBe("restore-into-empty");
  });

  it("defers the gap check when the backup exists but its version is unreadable (no secret yet)", () => {
    // Fresh origin: backup present, but reading its version needs the user's secret — the
    // restore flow re-checks post-decrypt. Booting must NOT halt here.
    const d = roamingBootDecision({
      ...base,
      lease: lease({ expiresAt: NOW - 1, heartbeatStateVersion: 50 }),
      localSeedPresent: false,
      localStateVersion: 0,
      backupStateVersion: null, // unreadable, file present
    });
    expect(d.action).toBe("restore-into-empty");
  });

  it("a MISSING backup file is readable evidence (v0) — the gap check still fires", () => {
    const d = roamingBootDecision({
      ...base,
      lease: lease({ expiresAt: NOW - 1, heartbeatStateVersion: 50 }),
      localSeedPresent: false,
      localStateVersion: 0,
      backupPresent: false,
      backupStateVersion: null,
    });
    expect(d.action).toBe("halt-version-gap");
  });

  it("released lease never triggers the gap check (clean handoff already flushed)", () => {
    const d = roamingBootDecision({
      ...base,
      lease: lease({ phase: "released", heartbeatStateVersion: 99 }),
      localSeedPresent: false,
      localStateVersion: 0,
    });
    expect(d.action).toBe("restore-into-empty");
  });

  it("no local wallet + backup present → restore-into-empty", () => {
    expect(roamingBootDecision({ ...base, lease: null, localSeedPresent: false, localStateVersion: 0 }).action).toBe(
      "restore-into-empty",
    );
  });

  it("no local wallet + no backup → setup-needed (creation lives in the wallet app)", () => {
    expect(
      roamingBootDecision({
        ...base,
        lease: null,
        localSeedPresent: false,
        localStateVersion: 0,
        backupPresent: false,
        backupStateVersion: null,
      }).action,
    ).toBe("setup-needed");
  });

  it("local wallet present → start (the controller's own guards take it from there)", () => {
    expect(roamingBootDecision({ ...base, lease: null }).action).toBe("start");
  });
});

describe("heartbeatDecision", () => {
  it("renews on our record or a missing one; evicts on any foreign owner", () => {
    expect(heartbeatDecision(lease({ owner: "me" }), "me")).toBe("renew");
    expect(heartbeatDecision(null, "me")).toBe("renew");
    expect(heartbeatDecision(lease({ owner: "claimant" }), "me")).toBe("evicted");
    // Even an EXPIRED foreign record means someone claimed the wallet since our last tick.
    expect(heartbeatDecision(lease({ owner: "claimant", expiresAt: NOW - 1 }), "me")).toBe("evicted");
  });
});

describe("shouldSelfFenceOnOutage", () => {
  it("fences only once failures span longer than the lease window", () => {
    expect(shouldSelfFenceOnOutage(null, NOW)).toBe(false);
    expect(shouldSelfFenceOnOutage(NOW - ROAMING_LEASE_MS, NOW)).toBe(false);
    expect(shouldSelfFenceOnOutage(NOW - ROAMING_LEASE_MS - 1, NOW)).toBe(true);
  });
});

describe("buildLeaseRecord", () => {
  it("bumps seq over the previous record and stamps the state version", () => {
    const r = buildLeaseRecord({
      ownerToken: "me",
      origin: "https://b.example",
      now: NOW,
      previous: lease({ seq: 7 }),
      heartbeatStateVersion: 43,
    });
    expect(r.seq).toBe(8);
    expect(r.owner).toBe("me");
    expect(r.heartbeatStateVersion).toBe(43);
    expect(r.phase).toBe("live");
    expect(r.expiresAt).toBe(NOW + ROAMING_LEASE_MS);
    expect(r.acquiredAt).toBe(NOW); // new owner → fresh acquiredAt
  });

  it("preserves acquiredAt across our own renewals", () => {
    const prev = lease({ owner: "me", acquiredAt: NOW - 90_000, seq: 9 });
    const r = buildLeaseRecord({
      ownerToken: "me",
      origin: "https://b.example",
      now: NOW,
      previous: prev,
      heartbeatStateVersion: 44,
    });
    expect(r.acquiredAt).toBe(NOW - 90_000);
  });
});

describe("takeoverMayProceed", () => {
  const base = {
    ourToken: "me",
    previousOwner: "other-token",
    backupModifiedAfterClaim: false,
    takeoverStartedAt: NOW,
    now: NOW + 10_000,
  };

  it("proceeds on the previous holder's handoff ack", () => {
    const record = lease({ owner: "me", handoffAck: { from: "other-token", flushedVersion: 50, at: NOW + 5_000 } });
    expect(takeoverMayProceed({ ...base, record })).toEqual({ proceed: true, reason: "acked" });
  });

  it("proceeds when the backup file was flushed after our claim", () => {
    expect(takeoverMayProceed({ ...base, record: lease({ owner: "me" }), backupModifiedAfterClaim: true })).toEqual({
      proceed: true,
      reason: "backup-flushed",
    });
  });

  it("waits, then times out to the version-gap check", () => {
    expect(takeoverMayProceed({ ...base, record: lease({ owner: "me" }) }).reason).toBe("waiting");
    expect(takeoverMayProceed({ ...base, record: lease({ owner: "me" }), now: NOW + 90_000 })).toEqual({
      proceed: true,
      reason: "timeout",
    });
  });

  it("detects losing the claim race to a third origin", () => {
    expect(takeoverMayProceed({ ...base, record: lease({ owner: "someone-else" }) })).toEqual({
      proceed: false,
      reason: "lost",
    });
  });
});

describe("parseLeaseRecord", () => {
  it("round-trips a valid record and rejects garbage", () => {
    const r = lease();
    expect(parseLeaseRecord(JSON.stringify(r))).toEqual(r);
    expect(parseLeaseRecord(null)).toBeNull();
    expect(parseLeaseRecord("not json")).toBeNull();
    expect(parseLeaseRecord(JSON.stringify({ owner: 5 }))).toBeNull();
    expect(parseLeaseRecord(JSON.stringify({ owner: "x", expiresAt: 1, phase: "weird" }))).toBeNull();
  });
});
