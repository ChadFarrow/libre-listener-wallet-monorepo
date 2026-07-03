import { describe, it, expect } from "vitest";
import { PermissionStore, QuotaExceededError, type KVStore } from "./permission-store";

function memKV(): KVStore {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => void m.set(k, v),
  };
}

const ORIGIN = "https://app.example";

describe("PermissionStore grants", () => {
  it("starts un-granted and becomes enabled after grant()", async () => {
    const s = new PermissionStore(memKV());
    expect(await s.isEnabled(ORIGIN)).toBe(false);
    await s.grant(ORIGIN, { spendingLimitSats: 1000 });
    expect(await s.isEnabled(ORIGIN)).toBe(true);
    const grants = await s.listGrants();
    expect(grants).toHaveLength(1);
    expect(grants[0].spendingLimitSats).toBe(1000);
  });

  it("revoke() removes the grant", async () => {
    const s = new PermissionStore(memKV());
    await s.grant(ORIGIN, { spendingLimitSats: 1000 });
    await s.revoke(ORIGIN);
    expect(await s.isEnabled(ORIGIN)).toBe(false);
  });

  it("persists across store instances (same KV)", async () => {
    const kv = memKV();
    await new PermissionStore(kv).grant(ORIGIN, { spendingLimitSats: 42 });
    const s2 = new PermissionStore(kv);
    expect(await s2.isEnabled(ORIGIN)).toBe(true);
    expect((await s2.getGrant(ORIGIN))!.spendingLimitSats).toBe(42);
  });
});

describe("PermissionStore spending cap", () => {
  it("debits within the cap and rejects over it, leaving spend unchanged", async () => {
    const s = new PermissionStore(memKV());
    await s.grant(ORIGIN, { spendingLimitSats: 1000 });
    await s.chargeIfWithinCap(ORIGIN, 600);
    expect((await s.getGrant(ORIGIN))!.spentTodaySats).toBe(600);
    await expect(s.chargeIfWithinCap(ORIGIN, 500)).rejects.toBeInstanceOf(QuotaExceededError);
    // The failed charge must NOT have debited.
    expect((await s.getGrant(ORIGIN))!.spentTodaySats).toBe(600);
    await s.chargeIfWithinCap(ORIGIN, 400); // exactly to the cap
    expect((await s.getGrant(ORIGIN))!.spentTodaySats).toBe(1000);
  });

  it("treats a 0 cap as unlimited", async () => {
    const s = new PermissionStore(memKV());
    await s.grant(ORIGIN, { spendingLimitSats: 0 });
    await s.chargeIfWithinCap(ORIGIN, 10_000_000);
    expect((await s.getGrant(ORIGIN))!.spentTodaySats).toBe(10_000_000);
  });

  it("resets the daily spend after 24h", async () => {
    let now = 1_000_000;
    const s = new PermissionStore(memKV(), () => now);
    await s.grant(ORIGIN, { spendingLimitSats: 1000 });
    await s.chargeIfWithinCap(ORIGIN, 900);
    now += 24 * 60 * 60 * 1000 + 1; // a day later
    await s.chargeIfWithinCap(ORIGIN, 900); // would exceed if not reset
    expect((await s.getGrant(ORIGIN))!.spentTodaySats).toBe(900);
  });

  it("refund() returns spend to the pool (floored at 0)", async () => {
    const s = new PermissionStore(memKV());
    await s.grant(ORIGIN, { spendingLimitSats: 1000 });
    await s.chargeIfWithinCap(ORIGIN, 700);
    await s.refund(ORIGIN, 700);
    expect((await s.getGrant(ORIGIN))!.spentTodaySats).toBe(0);
    await s.refund(ORIGIN, 999); // over-refund floors at 0
    expect((await s.getGrant(ORIGIN))!.spentTodaySats).toBe(0);
  });

  it("serializes concurrent charges so two can't both pass a cap only one fits (TOCTOU)", async () => {
    const s = new PermissionStore(memKV());
    await s.grant(ORIGIN, { spendingLimitSats: 1000 });
    // Fire two 600-sat charges concurrently; only one should succeed (600+600 > 1000).
    const results = await Promise.allSettled([
      s.chargeIfWithinCap(ORIGIN, 600),
      s.chargeIfWithinCap(ORIGIN, 600),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;
    expect(ok).toBe(1);
    expect(rejected).toBe(1);
    expect((await s.getGrant(ORIGIN))!.spentTodaySats).toBe(600);
  });
});
