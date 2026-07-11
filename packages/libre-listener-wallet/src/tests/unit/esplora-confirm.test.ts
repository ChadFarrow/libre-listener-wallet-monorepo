// @vitest-environment node
import { describe, it, expect } from "vitest";
import { planBuriedConfirmations, ldkTxidToDisplay, forwardSyncBatchEnd, MAX_FORWARD_BLOCKS_PER_SYNC } from "../../esplora-client";

describe("ldkTxidToDisplay", () => {
  it("reverses LDK little-endian txid bytes to esplora display hex", () => {
    // 0x01020304 (LE bytes) -> "04030201" (display)
    expect(ldkTxidToDisplay(new Uint8Array([0x01, 0x02, 0x03, 0x04]))).toBe("04030201");
  });
  it("does not mutate the input array", () => {
    const input = new Uint8Array([0xaa, 0xbb]);
    ldkTxidToDisplay(input);
    expect([...input]).toEqual([0xaa, 0xbb]);
  });
});

type Status = { confirmed: boolean; block_height?: number } | null;
const from = (m: Record<string, Status>) => async (txid: string): Promise<Status> => m[txid] ?? null;

describe("forwardSyncBatchEnd (long-freeze 429 throttle)", () => {
  it("processes the whole gap in one tick when it's within the cap", () => {
    expect(forwardSyncBatchEnd(100, 105, 20)).toBe(105);
  });

  it("caps a huge gap to a bounded batch (successive ticks finish the rest)", () => {
    expect(forwardSyncBatchEnd(100, 1000, 20)).toBe(120);
  });

  it("never exceeds the tip, and is a no-op when already at tip", () => {
    expect(forwardSyncBatchEnd(500, 500, 20)).toBe(500);
    expect(forwardSyncBatchEnd(500, 500, 20)).toBeLessThanOrEqual(500);
  });

  it("advances by at most MAX_FORWARD_BLOCKS_PER_SYNC per tick", () => {
    const best = 800_000;
    const next = forwardSyncBatchEnd(best, best + 10_000, MAX_FORWARD_BLOCKS_PER_SYNC);
    expect(next - best).toBe(MAX_FORWARD_BLOCKS_PER_SYNC);
  });
});

describe("planBuriedConfirmations", () => {
  it("groups buried-confirmed txs by ascending height", async () => {
    const r = await planBuriedConfirmations(
      ["a", "b"],
      from({ a: { confirmed: true, block_height: 100 }, b: { confirmed: true, block_height: 95 } }),
      100,
    );
    expect(r).toEqual([{ height: 95, txids: ["b"] }, { height: 100, txids: ["a"] }]);
  });

  it("excludes unconfirmed, null/missing, and block_height > bestHeight", async () => {
    const r = await planBuriedConfirmations(
      ["unconf", "future", "ok", "missing"],
      from({
        unconf: { confirmed: false },
        future: { confirmed: true, block_height: 101 },
        ok: { confirmed: true, block_height: 50 },
      }),
      100,
    );
    expect(r).toEqual([{ height: 50, txids: ["ok"] }]);
  });

  it("groups multiple txs confirmed in the same block", async () => {
    const r = await planBuriedConfirmations(
      ["x", "y"],
      from({ x: { confirmed: true, block_height: 80 }, y: { confirmed: true, block_height: 80 } }),
      100,
    );
    expect(r).toEqual([{ height: 80, txids: ["x", "y"] }]);
  });

  it("returns [] for empty input", async () => {
    expect(await planBuriedConfirmations([], async () => null, 100)).toEqual([]);
  });
});
