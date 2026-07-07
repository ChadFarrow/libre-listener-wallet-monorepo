import { describe, it, expect } from "vitest";
import { VssDeviceLease, VSS_DEVICE_LEASE_KEY } from "../../vss-device-lease";
import { CrossDeviceLockError } from "../../cross-device-lease-error";
import { VssError, type VssKeyValue } from "../../vss-client";
import { isCrossDeviceLockError } from "@libre/shared";

// In-memory VSS with the real version-CAS semantics: a putObjects whose version != the stored
// version (0 for a new key) throws a 409 VssError (isVssConflict). Lets us drive the lease logic
// deterministically without an HTTP server.
function memVss() {
  const store = new Map<string, { version: number; value: Uint8Array }>();
  return {
    store,
    async getObject(key: string): Promise<VssKeyValue | null> {
      const e = store.get(key);
      return e ? { key, version: e.version, value: e.value } : null;
    },
    async putObjects(items: VssKeyValue[]): Promise<void> {
      for (const it of items) {
        const cur = store.get(it.key);
        const expected = cur?.version ?? 0;
        if (it.version !== expected) throw new VssError("conflict", 409, 409);
        store.set(it.key, { version: expected + 1, value: it.value });
      }
    },
    async deleteObject(kv: VssKeyValue): Promise<void> {
      store.delete(kv.key);
    },
  };
}

const parseLease = (v: Uint8Array) => JSON.parse(new TextDecoder().decode(v)) as { owner: string; expiresAt: number };

describe("VssDeviceLease", () => {
  it("device A acquires; a SECOND device B is blocked while A's lease is live", async () => {
    const vss = memVss();
    const a = new VssDeviceLease(vss, "A");
    const b = new VssDeviceLease(vss, "B");

    await expect(a.acquire()).resolves.toEqual({ ok: true, degraded: false });
    expect(parseLease(vss.store.get(VSS_DEVICE_LEASE_KEY)!.value).owner).toBe("A");

    // B sees A's live lease → refuses to start.
    await expect(b.acquire()).rejects.toSatisfy(isCrossDeviceLockError);
    await expect(b.acquire()).rejects.toBeInstanceOf(CrossDeviceLockError);
  });

  it("after A releases, B can acquire", async () => {
    const vss = memVss();
    const a = new VssDeviceLease(vss, "A");
    const b = new VssDeviceLease(vss, "B");
    await a.acquire();
    await a.release();
    expect(vss.store.has(VSS_DEVICE_LEASE_KEY)).toBe(false);
    await expect(b.acquire()).resolves.toEqual({ ok: true, degraded: false });
  });

  it("takes over an EXPIRED lease from a crashed device (past the 2-min window)", async () => {
    const vss = memVss();
    const T = 1_000_000_000;
    const crashed = new VssDeviceLease(vss, "crashed", { now: () => T, leaseMs: 120_000 });
    await crashed.acquire(); // lease expires at T + 120_000
    // A fresh device 3 minutes later takes over (crashed never released).
    const fresh = new VssDeviceLease(vss, "fresh", { now: () => T + 180_000 });
    await expect(fresh.acquire()).resolves.toEqual({ ok: true, degraded: false });
    expect(parseLease(vss.store.get(VSS_DEVICE_LEASE_KEY)!.value).owner).toBe("fresh");
  });

  it("a restart of the SAME device (same owner) renews, not blocks", async () => {
    const vss = memVss();
    const a1 = new VssDeviceLease(vss, "sameowner");
    await a1.acquire();
    const a2 = new VssDeviceLease(vss, "sameowner"); // same owner id (simulated) restarting
    await expect(a2.acquire()).resolves.toEqual({ ok: true, degraded: false });
  });

  it("degrades (does NOT throw) when VSS is unreachable at acquire — start-with-warning", async () => {
    const downOnRead = {
      getObject: async () => { throw new Error("network down"); },
      putObjects: async () => {},
      deleteObject: async () => {},
    };
    const lease = new VssDeviceLease(downOnRead, "A");
    await expect(lease.acquire()).resolves.toEqual({ ok: false, degraded: true });
  });

  it("throws CrossDeviceLockError if the CAS write loses a concurrent race", async () => {
    // getObject shows an empty slot (→ decision 'acquire'), but the write conflicts (another device
    // claimed it in the same instant).
    const racing = {
      getObject: async (): Promise<VssKeyValue | null> => null,
      putObjects: async () => { throw new VssError("conflict", 409, 409); },
      deleteObject: async () => {},
    };
    const lease = new VssDeviceLease(racing, "A");
    await expect(lease.acquire()).rejects.toBeInstanceOf(CrossDeviceLockError);
  });
});
