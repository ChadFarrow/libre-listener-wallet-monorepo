// First-top-up guidance. The channel counterparty requires ~1% of capacity held on our side as an
// unspendable reserve (standard for lnd AND the LSPs — Megalith's get_info reports
// supports_zero_channel_reserve: false), so a first payment smaller than the reserve "vanishes":
// receivable drops but spendable stays 0. Seen live on mainnet 2026-07-09 — the user's first
// 1,000-sat top-up went entirely into the reserve. Estimate the reserve from capacity (the SDK's
// ChannelInfo doesn't expose the exact figure; 1% is the protocol default both sides use) and
// recommend an amount comfortably above it.
export interface ReserveHint {
  reserveSat: number;
  recommendedSat: number;
}

export function firstTopUpHint(opts: {
  spendableSat: number;
  usableChannelCapacitiesSat: number[];
}): ReserveHint | undefined {
  if (opts.spendableSat > 0) return undefined;
  if (opts.usableChannelCapacitiesSat.length === 0) return undefined;
  const capacity = Math.max(...opts.usableChannelCapacitiesSat);
  if (capacity <= 0) return undefined;
  const reserveSat = Math.ceil(capacity / 100);
  // Twice the reserve, rounded up to a clean 1000, never below 5000 — enough that the first
  // top-up visibly lands as spendable balance instead of disappearing into the deposit.
  const recommendedSat = Math.max(5000, Math.ceil((reserveSat * 2) / 1000) * 1000);
  return { reserveSat, recommendedSat };
}
