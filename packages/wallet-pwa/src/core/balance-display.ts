// What spendable-sats figure to show on the home hero, chosen to avoid an alarming "0" flash.
//
// getBalance() sums only USABLE channels. When the app resumes from the background the bridge
// WebSocket has usually dropped, so the channel is momentarily NOT usable and the sum reads 0 —
// for the second or two until the peer auto-reconnects. Showing that flashes "0 sats", which looks
// like the funds vanished. So when channels EXIST but none are usable and the reading is 0, hold
// the last confirmed value (stale) instead of rendering 0. A genuine 0 (spent down, but the channel
// is usable) still shows, and a stopped node still shows the placeholder.

export interface BalanceView {
  sats: number | null; // null → show the "—" placeholder
  stale: boolean; // true → held from a previous reading (peer reconnecting), not a fresh sum
}

export function balanceDisplay(opts: {
  balance: { spendableSat: number } | null | undefined;
  channels: number;
  usableChannels: number;
  lastShownSats: number | null;
}): BalanceView {
  const { balance, channels, usableChannels, lastShownSats } = opts;
  // Node stopped/starting: no balance object → placeholder, as before (honest, not stale funds).
  if (!balance) return { sats: null, stale: false };
  // Transient reconnect: a channel exists but none are usable yet and the sum is 0 → the 0 is
  // unreliable. Hold the last confirmed value rather than flash 0.
  if (channels > 0 && usableChannels === 0 && balance.spendableSat === 0 && lastShownSats != null) {
    return { sats: lastShownSats, stale: true };
  }
  return { sats: balance.spendableSat, stale: false };
}
