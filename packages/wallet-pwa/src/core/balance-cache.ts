// Persisted last-known spendable-sats, so a cold boot can show the real balance immediately instead
// of flashing "0" during the peer-reconnect window (see core/balance-display.ts). The in-memory
// `lastShownSats` holder in the home screen is lost on every page load, so on a fresh launch the
// anti-flash guard has nothing to hold — this localStorage cache seeds it. App-layer cache only (like
// the fiat-rate cache), NOT wallet storage: the real balance is always re-derived from channel state.

const LAST_BALANCE_KEY = "libre_last_balance_sats";

export function loadLastBalanceSats(): number | null {
  try {
    const raw = localStorage.getItem(LAST_BALANCE_KEY);
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export function saveLastBalanceSats(sats: number): void {
  try {
    if (!Number.isFinite(sats) || sats < 0) return;
    localStorage.setItem(LAST_BALANCE_KEY, String(Math.trunc(sats)));
  } catch {
    /* private-mode / storage-disabled: the cache just won't persist */
  }
}
