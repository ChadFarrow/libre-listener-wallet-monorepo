import { describe, it, expect } from "vitest";
import {
  parseHighwater,
  serializeHighwater,
  mergeHighwater,
  findRegression,
  highwaterEquals,
  ChannelStateRegressionError,
} from "../../state-highwater";

describe("parseHighwater", () => {
  it("returns empty map for null/empty", () => {
    expect(parseHighwater(null).size).toBe(0);
    expect(parseHighwater("").size).toBe(0);
  });
  it("parses decimal ids into bigints", () => {
    const m = parseHighwater('{"aa":"5","bb":"18446744073709551615"}');
    expect(m.get("aa")).toBe(5n);
    expect(m.get("bb")).toBe(18446744073709551615n);
  });
  it("degrades to empty on corrupt JSON (never throws — non-critical marker)", () => {
    expect(parseHighwater("not json").size).toBe(0);
  });
  it("skips a single bad entry without discarding the rest", () => {
    const m = parseHighwater('{"aa":"5","bb":"xyz"}');
    expect(m.get("aa")).toBe(5n);
    expect(m.has("bb")).toBe(false);
  });
});

describe("serializeHighwater round-trips", () => {
  it("survives parse(serialize(x))", () => {
    const m = new Map<string, bigint>([["aa", 5n], ["bb", 99n]]);
    expect(parseHighwater(serializeHighwater(m))).toEqual(m);
  });
});

describe("mergeHighwater", () => {
  it("takes the max per channel and adds new channels", () => {
    const stored = new Map<string, bigint>([["aa", 5n], ["bb", 10n]]);
    const merged = mergeHighwater(stored, [
      { channelId: "aa", latestUpdateId: 7n }, // advances
      { channelId: "bb", latestUpdateId: 9n }, // stays (lower ignored)
      { channelId: "cc", latestUpdateId: 1n }, // new
    ]);
    expect(merged.get("aa")).toBe(7n);
    expect(merged.get("bb")).toBe(10n);
    expect(merged.get("cc")).toBe(1n);
  });
  it("does not mutate the input", () => {
    const stored = new Map<string, bigint>([["aa", 5n]]);
    mergeHighwater(stored, [{ channelId: "aa", latestUpdateId: 9n }]);
    expect(stored.get("aa")).toBe(5n);
  });
});

describe("findRegression", () => {
  const stored = new Map<string, bigint>([["aa", 10n]]);
  it("flags a loaded monitor behind its high-water", () => {
    const r = findRegression([{ channelId: "aa", latestUpdateId: 3n }], stored);
    expect(r).toEqual({ channelId: "aa", loaded: 3n, highwater: 10n });
  });
  it("passes when loaded == high-water", () => {
    expect(findRegression([{ channelId: "aa", latestUpdateId: 10n }], stored)).toBeNull();
  });
  it("passes when loaded > high-water", () => {
    expect(findRegression([{ channelId: "aa", latestUpdateId: 11n }], stored)).toBeNull();
  });
  it("ignores a high-water entry with no loaded monitor (closed channel — no false halt)", () => {
    expect(findRegression([], stored)).toBeNull();
  });
});

describe("highwaterEquals", () => {
  it("true for equal maps, false otherwise", () => {
    expect(highwaterEquals(new Map([["a", 1n]]), new Map([["a", 1n]]))).toBe(true);
    expect(highwaterEquals(new Map([["a", 1n]]), new Map([["a", 2n]]))).toBe(false);
    expect(highwaterEquals(new Map([["a", 1n]]), new Map())).toBe(false);
  });
});

describe("ChannelStateRegressionError", () => {
  it("carries the channel + update ids and a restore-oriented message", () => {
    const e = new ChannelStateRegressionError({ channelId: "aa", loaded: 3n, highwater: 10n });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ChannelStateRegressionError");
    expect(e.channelId).toBe("aa");
    expect(e.loadedUpdateId).toBe(3n);
    expect(e.highwaterUpdateId).toBe(10n);
    expect(e.message).toMatch(/restore from a backup/i);
  });
});
