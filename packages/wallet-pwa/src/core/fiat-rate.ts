// Minimal USD rate for the balance/tx fiat line. One public source (mempool.space price
// API — same host as the default mainnet esplora), a 10-minute localStorage cache, and
// graceful absence: any failure returns the stale cache or null, and callers hide the
// fiat line entirely on null. USD only by design.

export const FIAT_CACHE_KEY = "libre_fiat_usd";
const TTL_MS = 10 * 60_000;
const PRICE_URL = "https://mempool.space/api/v1/prices";

interface CachedRate {
  rate: number;
  ts: number;
}

function readCache(): CachedRate | null {
  try {
    const raw = localStorage.getItem(FIAT_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedRate;
    if (typeof parsed.rate !== "number" || !Number.isFinite(parsed.rate)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function getUsdRate(opts?: { fetchImpl?: typeof fetch; now?: number }): Promise<number | null> {
  const now = opts?.now ?? Date.now();
  const cached = readCache();
  if (cached && now - cached.ts < TTL_MS) return cached.rate;

  // Never store-and-call as a method — the browser's fetch brand-check rejects it.
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch.bind(globalThis);
  try {
    const res = await fetchImpl(PRICE_URL);
    const body = (await res.json()) as { USD?: unknown };
    const rate = body?.USD;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) throw new Error("bad price payload");
    try {
      localStorage.setItem(FIAT_CACHE_KEY, JSON.stringify({ rate, ts: now } satisfies CachedRate));
    } catch {
      // private mode — the fresh value still serves this call
    }
    return rate;
  } catch {
    return cached?.rate ?? null;
  }
}

export function satsToUsd(sats: number, usdPerBtc: number): number {
  return (sats / 100_000_000) * usdPerBtc;
}
