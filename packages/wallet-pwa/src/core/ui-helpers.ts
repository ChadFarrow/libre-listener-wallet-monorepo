// Small DOM/UI utilities shared across feature modules.

/**
 * Bind a single-flight click handler: the button is disabled for the whole async handler and
 * re-enabled in finally, so a double-tap can't run it twice (e.g. minting two NWC pairings —
 * two spend secrets — or dialing a peer twice). Use this for any button whose handler awaits.
 */
export function guardedClick(btn: HTMLButtonElement, handler: () => Promise<void>): void {
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    btn.disabled = true;
    void handler().finally(() => {
      btn.disabled = false;
    });
  });
}
