import type { AppContext } from "../core/app-context";
import { onControllerEvent } from "../core/events";
import { newSettledReceived, settledReceivedIds } from "../core/receive-settle";
import { firstTopUpHint } from "../core/reserve-hint";
import { registerScreen, currentScreen, resetToHome } from "../ui/nav";
import { renderQr } from "../ui/qr";
import { $, show, setMsg, fmtSats, copyText } from "./util";

const DEFAULT_AMOUNT = 5000;
const SETTLE_POLL_MS = 3000;
const AUTO_HOME_MS = 2500;

export function initReceiveScreen(ctx: AppContext): void {
  const controller = ctx.controller;
  const amountEl = $<HTMLInputElement>("recv-amount");
  let userEdited = false;
  let mintTimer: ReturnType<typeof setTimeout> | undefined;
  let mintToken = 0;

  // Paid detection: snapshot the settled received payment ids when the screen opens; any
  // settled received record NOT in that baseline while the screen is up means the user got
  // paid → full-cover "Payment received" + back home. Triggered by controller state-changed
  // events (incl. the one main.ts emits on visibilitychange, so a payment that settled while
  // the PWA was backgrounded is caught the moment the user returns) plus a slow poll.
  let baseline: Set<string> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let homeTimer: ReturnType<typeof setTimeout> | undefined;

  function stopWatch(): void {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }

  function hidePaid(): void {
    show("recv-result", false);
  }

  function showPaid(amountSats: number): void {
    $("recv-result-amount").textContent = amountSats > 0 ? `+${fmtSats(amountSats)} sats` : "";
    show("recv-result", true);
  }

  async function checkSettled(): Promise<void> {
    if (!baseline) return;
    if (currentScreen() !== "screen-receive") {
      // resetToHome() doesn't run onHide hooks — self-clean if the screen was left that way.
      stopWatch();
      return;
    }
    const recs = await controller.getPayments().catch(() => []);
    if (!baseline) return; // screen hidden while we awaited
    const hit = newSettledReceived(baseline, recs);
    if (!hit) return;
    baseline = undefined; // one-shot
    stopWatch();
    showPaid(hit.amountSats);
    homeTimer = setTimeout(() => {
      if (currentScreen() === "screen-receive") {
        hidePaid();
        resetToHome();
      }
    }, AUTO_HOME_MS);
  }

  async function armPaidWatch(): Promise<void> {
    const recs = await controller.getPayments().catch(() => []);
    if (currentScreen() !== "screen-receive") return;
    baseline = settledReceivedIds(recs);
    stopWatch();
    pollTimer = setInterval(() => void checkSettled(), SETTLE_POLL_MS);
  }

  function amountSats(): number {
    return parseInt(amountEl.value.replace(/\D/g, "") || "0", 10);
  }

  function syncAmountField(): void {
    const digits = amountEl.value.replace(/\D/g, "").slice(0, 9);
    const n = parseInt(digits || "0", 10);
    amountEl.value = n ? fmtSats(n) : "";
    amountEl.style.width = `${Math.max(amountEl.value.length + 1, 3)}ch`;
  }

  async function mint(): Promise<void> {
    const token = ++mintToken;
    const amt = amountSats();
    if (!amt) return;
    setMsg("receive-msg", "Creating invoice…");
    try {
      const { paymentRequest } = await controller.createInvoice(amt);
      if (token !== mintToken || currentScreen() !== "screen-receive") return; // stale mint
      const out = $<HTMLTextAreaElement>("invoice-out");
      out.value = paymentRequest;
      show(out, true);
      show("copy-invoice", true);
      await renderQr($<HTMLImageElement>("invoice-qr"), paymentRequest);
      setMsg("receive-msg", "Scan or pay this invoice from another wallet", "ok");
    } catch (e) {
      if (token !== mintToken) return;
      show("invoice-qr", false);
      show("invoice-out", false);
      show("copy-invoice", false);
      setMsg("receive-msg", (e as Error).message, "err");
    }
  }

  async function onShow(): Promise<void> {
    hidePaid();
    const s = await controller.getState().catch(() => null);
    if (!s?.running) {
      show("invoice-qr", false);
      show("invoice-out", false);
      show("copy-invoice", false);
      show("reserve-hint", false);
      setMsg("receive-msg", "The node isn't running — start it from the menu first.", "err");
      return;
    }
    void armPaidWatch();
    // First-top-up reserve guidance: while spendable is 0 with a usable channel, the first ~1%
    // fills the channel reserve — recommend an amount that visibly lands. Never overrides an
    // amount the user typed themselves.
    let hint;
    try {
      const chans = await controller.getChannels();
      hint = firstTopUpHint({
        spendableSat: s.balance?.spendableSat ?? 0,
        usableChannelCapacitiesSat: chans.filter((c) => c.isUsable).map((c) => c.capacitySat),
      });
    } catch {
      hint = undefined;
    }
    show("reserve-hint", !!hint);
    if (hint) {
      $("reserve-hint").textContent =
        `Tip: your channel keeps ~${fmtSats(hint.reserveSat)} sats as an unspendable reserve ` +
        `(returned when it closes). Make your first top-up at least ${fmtSats(hint.recommendedSat)} sats ` +
        `so it shows up as spendable.`;
      if (!userEdited && amountSats() === DEFAULT_AMOUNT) {
        amountEl.value = fmtSats(hint.recommendedSat);
      }
    }
    syncAmountField();
    void mint();
  }

  function onHide(): void {
    stopWatch();
    clearTimeout(homeTimer);
    homeTimer = undefined;
    baseline = undefined;
    hidePaid();
  }

  amountEl.addEventListener("input", () => {
    userEdited = true;
    syncAmountField();
    clearTimeout(mintTimer);
    mintTimer = setTimeout(() => void mint(), 800);
  });
  $("recv-amount-edit").addEventListener("click", () => {
    amountEl.focus();
    amountEl.select();
  });
  $("copy-invoice").addEventListener("click", () => {
    void copyText($<HTMLTextAreaElement>("invoice-out").value).then((ok) =>
      setMsg("receive-msg", ok ? "Invoice copied" : "Couldn't copy — select the invoice text manually.", ok ? "ok" : "err"),
    );
  });
  $("recv-result-done").addEventListener("click", () => {
    clearTimeout(homeTimer);
    homeTimer = undefined;
    hidePaid();
    resetToHome();
  });

  onControllerEvent(() => {
    if (currentScreen() === "screen-receive") void checkSettled();
  });

  syncAmountField();
  registerScreen("screen-receive", { onShow: () => void onShow(), onHide });
}
