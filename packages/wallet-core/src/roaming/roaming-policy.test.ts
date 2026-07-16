import { describe, it, expect } from "vitest";
import {
  leaseState,
  roamingBootDecision,
  heartbeatDecision,
  shouldSelfFenceOnOutage,
  buildLeaseRecord,
  evaluateHandoffProof,
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

  // ISSUE #90, as one assertion. A holder that dies AFTER its last 40s heartbeat leaves
  // advertised == backup — its post-heartbeat state is invisible to every successor. The old
  // check only caught advertised > backup, so this restored a 9-commitments-stale backup onto a
  // live mainnet channel and the peer force-closed it. No proof of a clean handoff ⇒ no restore.
  it("a holder that died at its last heartbeat (advertised == backup) → halt, NOT restore", () => {
    const d = roamingBootDecision({
      ...base,
      lease: lease({ phase: "live", heartbeatStateVersion: 42 }),
      leaseClaimed: true, // we took it over; the ack never came (the holder is dead)
      backupStateVersion: 42,
      localSeedPresent: false,
      localStateVersion: 0,
    });
    expect(d.action).toBe("halt-version-gap");
  });

  it("expired foreign lease advertising MORE state than the backup → halt-version-gap", () => {
    // Origin A crashed without its final flush: lease says v50, backup only has v42, we have v40.
    const d = roamingBootDecision({
      ...base,
      lease: lease({ expiresAt: NOW - 1, heartbeatStateVersion: 50 }),
      localStateVersion: 40,
    });
    expect(d).toEqual({
      action: "halt-version-gap",
      staleOrigin: "https://a.example",
      missingVersions: 8,
      overridable: true,
    });
  });

  // The reload hole. Exception (a) ("we hold the missing state") compares against a record WE
  // wrote — and our claim stamps OUR version (0 on a fresh origin, 10 for a stale origin A) over
  // the predecessor's. Reading that back, (a) scores true and starts on state the predecessor has
  // outrun. unprovenPredecessor is what survives our own writes.
  it("our own claim cannot launder the predecessor's advertised version away", () => {
    const ours = buildLeaseRecord({
      ownerToken: "tok-b",
      origin: "https://b.example",
      now: NOW,
      previous: lease({ owner: "tok-a", heartbeatStateVersion: 20 }),
      heartbeatStateVersion: 10, // our stale local state
    });
    expect(ours.heartbeatStateVersion).toBe(10); // we really did stamp our own version...
    expect(ours.unprovenPredecessor).toEqual({
      owner: "tok-a",
      origin: "https://a.example",
      advertisedVersion: 20, // ...but the predecessor's high-water mark rides along
      since: NOW,
    });
    // Feed our own record back in, as a reload does (a reload mints a new token, so it reads its
    // own prior record as a foreign live lease → blocked → Move-here → claimed → here).
    const d = roamingBootDecision({
      ...base,
      lease: ours,
      leaseClaimed: true,
      localStateVersion: 10,
      backupStateVersion: 15,
    });
    expect(d.action).toBe("halt-version-gap");
  });

  it("carries the high-water mark through a chain of unproven claims", () => {
    // A dies at v20 → B claims and halts → B reloads (new token) → C claims. C must still see A.
    const b = buildLeaseRecord({
      ownerToken: "tok-b",
      origin: "https://b.example",
      now: NOW,
      previous: lease({ owner: "tok-a", heartbeatStateVersion: 20 }),
      heartbeatStateVersion: 0,
    });
    const c = buildLeaseRecord({
      ownerToken: "tok-c",
      origin: "https://c.example",
      now: NOW + 1_000,
      previous: b,
      heartbeatStateVersion: 0,
    });
    expect(c.unprovenPredecessor?.advertisedVersion).toBe(20);
    expect(
      roamingBootDecision({
        ...base,
        lease: c,
        leaseClaimed: true,
        localSeedPresent: false,
        localStateVersion: 0,
      }).action,
    ).toBe("halt-version-gap");
  });

  it("our own renewal carries the predecessor verbatim (it is not re-snapshotted as ourselves)", () => {
    const claim = buildLeaseRecord({
      ownerToken: "tok-b",
      origin: "https://b.example",
      now: NOW,
      previous: lease({ owner: "tok-a", heartbeatStateVersion: 20 }),
      heartbeatStateVersion: 0,
    });
    const renewed = buildLeaseRecord({
      ownerToken: "tok-b",
      origin: "https://b.example",
      now: NOW + 40_000,
      previous: claim,
      heartbeatStateVersion: 3,
    });
    expect(renewed.unprovenPredecessor).toEqual(claim.unprovenPredecessor);
  });

  it("a released predecessor leaves nothing to carry, and the override clears it", () => {
    expect(
      buildLeaseRecord({
        ownerToken: "tok-b",
        origin: "https://b.example",
        now: NOW,
        previous: lease({ phase: "released", heartbeatStateVersion: 20 }),
        heartbeatStateVersion: 0,
      }).unprovenPredecessor,
    ).toBeUndefined();
    expect(
      buildLeaseRecord({
        ownerToken: "tok-b",
        origin: "https://b.example",
        now: NOW,
        previous: lease({ owner: "tok-a", heartbeatStateVersion: 20 }),
        heartbeatStateVersion: 0,
        clearPredecessor: true,
      }).unprovenPredecessor,
    ).toBeUndefined();
  });

  it("the user's explicit override proceeds past an unproven handoff", () => {
    const d = roamingBootDecision({
      ...base,
      lease: lease({ phase: "live", heartbeatStateVersion: 50 }),
      leaseClaimed: true,
      localSeedPresent: false,
      localStateVersion: 0,
      override: true,
    });
    expect(d.action).toBe("restore-into-empty");
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
    takeoverStartedAt: NOW,
    now: NOW + 10_000,
  };

  it("proceeds on the previous holder's handoff ack", () => {
    const record = lease({ owner: "me", handoffAck: { from: "other-token", flushedVersion: 50, at: NOW + 5_000 } });
    expect(takeoverMayProceed({ ...base, record })).toEqual({ proceed: true, reason: "acked" });
  });

  it("stops waiting on timeout — which is NOT permission to restore (the proof gate decides)", () => {
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

describe("evaluateHandoffProof", () => {
  const base = { backupStateVersion: 42, localSeedPresent: false, localStateVersion: 0 };

  it("proves a clean handoff from the predecessor itself — released, or an ack within the backup", () => {
    expect(evaluateHandoffProof({ ...base, lease: null })).toEqual({ proven: true, via: "no-predecessor" });
    expect(evaluateHandoffProof({ ...base, lease: lease({ phase: "released" }) })).toEqual({
      proven: true,
      via: "released",
    });
    expect(
      evaluateHandoffProof({
        ...base,
        lease: lease({ owner: "tok-a" }),
        postClaimLease: lease({ owner: "me", handoffAck: { from: "tok-a", flushedVersion: 42, at: NOW } }),
      }),
    ).toEqual({ proven: true, via: "ack" });
  });

  it("rejects an ack claiming MORE than the backup actually holds", () => {
    // The holder acks flushedVersion 50 but Drive only has 42 — its upload didn't land. Trusting
    // the ack alone would restore v42 onto a v50 channel.
    const p = evaluateHandoffProof({
      ...base,
      lease: lease({ owner: "tok-a" }),
      postClaimLease: lease({ owner: "me", handoffAck: { from: "tok-a", flushedVersion: 50, at: NOW } }),
    });
    expect(p.proven).toBe(false);
  });

  it("rejects an ack when the backup version is unreadable (unreadable must fail, not pass)", () => {
    const p = evaluateHandoffProof({
      ...base,
      backupStateVersion: null,
      lease: lease({ owner: "tok-a" }),
      postClaimLease: lease({ owner: "me", handoffAck: { from: "tok-a", flushedVersion: 0, at: NOW } }),
    });
    expect(p.proven).toBe(false);
  });

  it("rejects an ack from someone who is not the predecessor", () => {
    const p = evaluateHandoffProof({
      ...base,
      lease: lease({ owner: "tok-a" }),
      postClaimLease: lease({ owner: "me", handoffAck: { from: "tok-stranger", flushedVersion: 42, at: NOW } }),
    });
    expect(p.proven).toBe(false);
  });

  it("proves via local state only when we actually HAVE a wallet here", () => {
    // Origin A reopening with the real state → start; our flush catches Drive up.
    expect(
      evaluateHandoffProof({ ...base, lease: lease(), localSeedPresent: true, localStateVersion: 42 }),
    ).toEqual({ proven: true, via: "local-state" });
    // A fresh origin scoring 0 >= 0 against a zeroed record is EXACTLY issue #90 — the seed gate
    // is what stops it.
    expect(
      evaluateHandoffProof({
        ...base,
        lease: lease({ heartbeatStateVersion: 0 }),
        localSeedPresent: false,
        localStateVersion: 0,
      }).proven,
    ).toBe(false);
  });

  it("names the ORIGINAL stale origin, not the intermediate claimant", () => {
    const p = evaluateHandoffProof({
      ...base,
      lease: lease({
        owner: "tok-b",
        origin: "https://b.example",
        heartbeatStateVersion: 0,
        unprovenPredecessor: { owner: "tok-a", origin: "https://a.example", advertisedVersion: 20, since: NOW },
      }),
    });
    expect(p).toEqual({ proven: false, staleOrigin: "https://a.example", advertisedVersion: 20, backupVersion: 42 });
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
