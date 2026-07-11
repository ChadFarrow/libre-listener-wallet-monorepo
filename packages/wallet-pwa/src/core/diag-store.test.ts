import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { DiagStore, deleteDiagDb } from "./diag-store";
import type { DiagEntry } from "./diag-log";

const e = (i: number): DiagEntry => ({ at: 1_783_800_000_000 + i, level: "log", msg: `m${i}` });

describe("DiagStore", () => {
  beforeEach(async () => {
    await deleteDiagDb();
  });

  it("appends and reads back in insertion order", async () => {
    const s = new DiagStore();
    await s.append([e(0), e(1)], 100);
    await s.append([e(2)], 100);
    const all = await s.readAll();
    expect(all.map((x) => x.msg)).toEqual(["m0", "m1", "m2"]);
    expect(await s.count()).toBe(3);
  });

  it("enforces the ring cap by deleting the oldest overflow on append", async () => {
    const s = new DiagStore();
    await s.append([e(0), e(1), e(2)], 100);
    await s.append([e(3), e(4)], 4); // cap 4 → oldest (m0) must go
    const all = await s.readAll();
    expect(all.map((x) => x.msg)).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("clear() empties the store", async () => {
    const s = new DiagStore();
    await s.append([e(0)], 100);
    await s.clear();
    expect(await s.count()).toBe(0);
    expect(await s.readAll()).toEqual([]);
  });
});
