import { describe, it, expect, beforeEach } from "vitest";
import { getUsdRate, FIAT_CACHE_KEY } from "./fiat-rate";

const NOW = 1_700_000_000_000;

function fakeFetch(responses: Array<{ ok: boolean; body?: unknown }>) {
  const calls: string[] = [];
  const impl = async (url: string | URL | Request) => {
    calls.push(String(url));
    const next = responses.shift();
    if (!next) throw new Error("no scripted response left");
    if (!next.ok) throw new Error("network down");
    return new Response(JSON.stringify(next.body), { status: 200 });
  };
  return { impl: impl as typeof fetch, calls };
}

describe("getUsdRate", () => {
  beforeEach(() => localStorage.clear());

  it("fetches the mempool.space price and caches it", async () => {
    const { impl, calls } = fakeFetch([{ ok: true, body: { USD: 62_500 } }]);
    const rate = await getUsdRate({ fetchImpl: impl, now: NOW });
    expect(rate).toBe(62_500);
    expect(calls[0]).toContain("mempool.space/api/v1/prices");
    expect(JSON.parse(localStorage.getItem(FIAT_CACHE_KEY)!)).toMatchObject({ rate: 62_500, ts: NOW });
  });

  it("serves a fresh cache without a second fetch", async () => {
    localStorage.setItem(FIAT_CACHE_KEY, JSON.stringify({ rate: 60_000, ts: NOW - 60_000 }));
    const { impl, calls } = fakeFetch([]);
    const rate = await getUsdRate({ fetchImpl: impl, now: NOW });
    expect(rate).toBe(60_000);
    expect(calls).toHaveLength(0);
  });

  it("refetches once the cache is older than the TTL", async () => {
    localStorage.setItem(FIAT_CACHE_KEY, JSON.stringify({ rate: 60_000, ts: NOW - 11 * 60_000 }));
    const { impl, calls } = fakeFetch([{ ok: true, body: { USD: 63_000 } }]);
    const rate = await getUsdRate({ fetchImpl: impl, now: NOW });
    expect(rate).toBe(63_000);
    expect(calls).toHaveLength(1);
  });

  it("falls back to the stale cache when the fetch fails", async () => {
    localStorage.setItem(FIAT_CACHE_KEY, JSON.stringify({ rate: 59_000, ts: NOW - 60 * 60_000 }));
    const { impl } = fakeFetch([{ ok: false }]);
    const rate = await getUsdRate({ fetchImpl: impl, now: NOW });
    expect(rate).toBe(59_000);
  });

  it("returns null when the fetch fails and no cache exists", async () => {
    const { impl } = fakeFetch([{ ok: false }]);
    const rate = await getUsdRate({ fetchImpl: impl, now: NOW });
    expect(rate).toBeNull();
  });

  it("rejects a malformed price payload without caching it", async () => {
    const { impl } = fakeFetch([{ ok: true, body: { USD: "not-a-number" } }]);
    const rate = await getUsdRate({ fetchImpl: impl, now: NOW });
    expect(rate).toBeNull();
    expect(localStorage.getItem(FIAT_CACHE_KEY)).toBeNull();
  });
});

describe("satsToUsd", () => {
  it("converts sats at the given rate", async () => {
    const { satsToUsd } = await import("./fiat-rate");
    expect(satsToUsd(21_847, 62_500)).toBeCloseTo(13.65, 2);
    expect(satsToUsd(0, 62_500)).toBe(0);
  });
});
