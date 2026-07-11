import { describe, it, expect } from "vitest";
import { DiagBuffer, DEFAULT_DIAG_POLICY, formatDiagLines } from "./diag-log";

const T0 = 1_783_800_000_000;

describe("DiagBuffer", () => {
  it("records entries and reports count", () => {
    const b = new DiagBuffer();
    expect(b.add("log", "hello", T0)).toBe(false); // 1 entry, <50 and <2s → no flush yet
    expect(b.count()).toBe(1);
    expect(b.snapshot()).toEqual([{ at: T0, level: "log", msg: "hello" }]);
  });

  it("drops lines containing [TRACE] (LDK trace spam)", () => {
    const b = new DiagBuffer();
    b.add("log", "[LDK] [TRACE] [LDK][lightning::ln::channel] noisy", T0);
    expect(b.count()).toBe(0);
  });

  it("truncates long lines with a …[+N chars] suffix", () => {
    const b = new DiagBuffer({ ...DEFAULT_DIAG_POLICY, maxLine: 10 });
    b.add("log", "0123456789ABCDE", T0);
    expect(b.snapshot()[0].msg).toBe("0123456789…[+5 chars]");
  });

  it("ring cap drops the oldest entries", () => {
    const b = new DiagBuffer({ ...DEFAULT_DIAG_POLICY, cap: 3 });
    for (let i = 0; i < 5; i++) b.add("log", `m${i}`, T0 + i);
    expect(b.count()).toBe(3);
    expect(b.snapshot().map((e) => e.msg)).toEqual(["m2", "m3", "m4"]);
  });

  it("flush is due after batchCount unflushed entries", () => {
    const b = new DiagBuffer({ ...DEFAULT_DIAG_POLICY, batchCount: 3 });
    expect(b.add("log", "a", T0)).toBe(false);
    expect(b.add("log", "b", T0 + 1)).toBe(false);
    expect(b.add("log", "c", T0 + 2)).toBe(true); // 3rd unflushed → due
  });

  it("flush is due batchMs after the FIRST unflushed entry", () => {
    const b = new DiagBuffer();
    b.add("log", "a", T0);
    expect(b.flushDue(T0 + 1999)).toBe(false);
    expect(b.flushDue(T0 + 2000)).toBe(true);
  });

  it("batchMs anchor follows eviction — measures from the oldest SURVIVING unflushed entry", () => {
    const b = new DiagBuffer({ ...DEFAULT_DIAG_POLICY, cap: 2 });
    b.add("log", "a", T0);        // will be evicted
    b.add("log", "b", T0 + 100);
    b.add("log", "c", T0 + 200);  // evicts a@T0; oldest survivor is b@T0+100
    expect(b.flushDue(T0 + 2000)).toBe(false); // 2000 - 100 = 1900 < batchMs → NOT due (old bug fired here)
    expect(b.flushDue(T0 + 2100)).toBe(true);  // b's window elapsed
  });

  it("drainUnflushed empties the pending batch and resets the timer window", () => {
    const b = new DiagBuffer();
    b.add("log", "a", T0);
    b.add("warn", "b", T0 + 1);
    const drained = b.drainUnflushed();
    expect(drained.map((e) => e.msg)).toEqual(["a", "b"]);
    expect(b.drainUnflushed()).toEqual([]);
    expect(b.flushDue(T0 + 10_000)).toBe(false); // nothing unflushed → never due
  });

  it("clear() wipes memory", () => {
    const b = new DiagBuffer();
    b.add("log", "a", T0);
    b.clear();
    expect(b.count()).toBe(0);
    expect(b.drainUnflushed()).toEqual([]);
  });

  it("formatDiagLines renders ISO time + upper level + message", () => {
    const out = formatDiagLines([{ at: Date.UTC(2026, 6, 11, 12, 0, 0), level: "error", msg: "boom" }]);
    expect(out).toBe("2026-07-11T12:00:00.000Z ERROR boom");
  });
});
