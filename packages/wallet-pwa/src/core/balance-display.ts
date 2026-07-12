// What spendable-sats figure to show on the home hero, chosen to avoid an alarming "0" flash.
//
// getBalance() sums only channels LDK currently reports as usable. That flips to not-usable during
// every in-flight monitor persist, a socket blip, a cold-boot channel load, or a background→resume
// peer drop — and during those windows the sum reads 0 for a second or two even though the funds are
// fine. Showing that flashes "0 sats", which looks like the money vanished.
//
// The reliable "this wallet SHOULD have a balance" signal is `hasChannelState` — a persisted
// channel_manager exists, true from boot for any funded wallet. The reliable "nothing is usable right
// now" signal is BOTH spendable AND receivable summing to 0: a usable channel always contributes some
// liquidity to one side or the other, so spendable 0 + receivable 0 means no channel is contributing
// at all (converging), whereas a channel that's simply spent down still has receivable > 0.
//
// NOTE: deliberately does NOT use the usable-channel COUNT — that count is smoothed (held for a grace
// window so the drawer doesn't flash "0/1"), so it stays at 1 during the very dip where getBalance()
// reads 0. Trusting the count there is exactly what made the balance flash 0 (1549 → 0 → 1549).
//
// So: wallet has channel state and both sides read 0 → hold the last confirmed value (stale) if we
// have one, else the "—" loading placeholder — never a hard 0. A genuine 0 (a channel spent down, so
// receivable > 0) still shows 0, a brand-new wallet with no channel state shows its real 0, and a
// stopped node shows the placeholder.

export interface BalanceView {
  sats: number | null; // null → show the "—" placeholder
  stale: boolean; // true → held from a previous reading (still converging), not a fresh sum
}

export function balanceDisplay(opts: {
  balance: { spendableSat: number; receivableSat: number } | null | undefined;
  hasChannelState: boolean;
  lastShownSats: number | null;
}): BalanceView {
  const { balance, hasChannelState, lastShownSats } = opts;
  // Node stopped/starting: no balance object → placeholder (honest, not stale funds).
  if (!balance) return { sats: null, stale: false };
  // Converging: funded wallet, but no channel is contributing any liquidity yet (both sides 0) → the
  // 0 is unreliable. Hold the last confirmed value if we have one, else the "—" loading placeholder.
  if (hasChannelState && balance.spendableSat === 0 && balance.receivableSat === 0) {
    return { sats: lastShownSats, stale: true };
  }
  return { sats: balance.spendableSat, stale: false };
}
