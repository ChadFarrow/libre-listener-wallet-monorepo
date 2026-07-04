// Pure helpers for the LSPS1 provider picker: surface the real cost so the user's choice between
// Megalith and Olympus (ZEUS) is informed, and guard a requested channel size against the selected
// provider's advertised bounds (live-verified 2026-07-04 — e.g. Megalith rejects anything below 150k).
import { LSPS1_REST_PROVIDERS, type Lsps1RestProvider } from "@libre/shared";

// Format the LSP opening fee for display: absolute sats + percentage of the channel size. Accepts a
// string too — LSPS1 REST returns sat amounts as strings (e.g. order.feeTotalSat).
export function formatOpeningFee(feeSat: number | string | undefined, amountSat: number): string {
  const fee = typeof feeSat === "string" ? Number(feeSat) : feeSat;
  if (fee == null || feeSat === "" || !Number.isFinite(fee)) return "fee unknown";
  const pct = amountSat > 0 ? (fee / amountSat) * 100 : 0;
  const pctStr = amountSat > 0 ? ` (${pct.toFixed(2)}% of ${amountSat.toLocaleString("en-US")} sat)` : "";
  return `${fee.toLocaleString("en-US")} sat${pctStr}`;
}

// Validate a requested channel size against ONE provider's advertised bounds. Speaks only about the
// given provider; use suggestProviderForAmount to point the user at an alternative that fits.
export function validateAmountForProvider(
  amountSat: number,
  p: Pick<Lsps1RestProvider, "name" | "minChannelSat" | "maxChannelSat">
): { ok: boolean; message?: string } {
  if (!Number.isFinite(amountSat) || amountSat <= 0) {
    return { ok: false, message: "Enter a channel size in sats." };
  }
  if (amountSat < p.minChannelSat) {
    return {
      ok: false,
      message: `${p.name} requires at least ${p.minChannelSat.toLocaleString("en-US")} sat per channel.`,
    };
  }
  if (amountSat > p.maxChannelSat) {
    return {
      ok: false,
      message: `${p.name} tops out at ${p.maxChannelSat.toLocaleString("en-US")} sat per channel.`,
    };
  }
  return { ok: true };
}

// Find another configured provider whose bounds DO include the amount (for an out-of-range request).
export function suggestProviderForAmount(
  amountSat: number,
  exceptKey: string
): { key: string; provider: Lsps1RestProvider } | undefined {
  for (const [key, provider] of Object.entries(LSPS1_REST_PROVIDERS)) {
    if (key === exceptKey) continue;
    if (amountSat >= provider.minChannelSat && amountSat <= provider.maxChannelSat) {
      return { key, provider };
    }
  }
  return undefined;
}

// A lease-duration option is offerable on a provider only if its block count is within the LSP's
// advertised max lease (Megalith ~13,140 blk / 3mo; Olympus ~52,560 blk / 12mo). "Longest available"
// (empty value → 0 blocks) is always offerable. Prevents showing a 6/12-month option on Megalith,
// which the SDK would silently clamp back down to ~3 months.
export function isLeaseOptionAvailable(optionBlocks: number, maxLeaseBlocks: number): boolean {
  if (!optionBlocks) return true; // 0 / "" = "Longest available"
  return optionBlocks <= maxLeaseBlocks;
}

// If a selected lease exceeds what the provider offers, fall back to "Longest available" ("").
export function clampLeaseSelectionValue(currentValue: string, maxLeaseBlocks: number): string {
  if (!currentValue) return currentValue; // "" stays "" (longest available)
  const blocks = parseInt(currentValue, 10);
  if (Number.isNaN(blocks)) return currentValue;
  return blocks <= maxLeaseBlocks ? currentValue : "";
}

// One-line human summary of a provider's cost/lease character + sat bounds, for the picker help text.
export function providerSummary(p: Lsps1RestProvider): string {
  const bounds = `${p.minChannelSat.toLocaleString("en-US")}–${p.maxChannelSat.toLocaleString("en-US")} sat`;
  return `${p.costNote} · ${bounds}`;
}
