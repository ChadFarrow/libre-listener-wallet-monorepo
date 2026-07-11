import type { AppContext } from "../core/app-context";
import { firstTopUpHint } from "../core/reserve-hint";
import { registerScreen, currentScreen } from "../ui/nav";
import { renderQr } from "../ui/qr";
import { $, show, setMsg, fmtSats, copyText } from "./util";

const DEFAULT_AMOUNT = 5000;

export function initReceiveScreen(ctx: AppContext): void {
  const controller = ctx.controller;
  const amountEl = $<HTMLInputElement>("recv-amount");
  let userEdited = false;
  let mintTimer: ReturnType<typeof setTimeout> | undefined;
  let mintToken = 0;

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
    const s = await controller.getState().catch(() => null);
    if (!s?.running) {
      show("invoice-qr", false);
      show("invoice-out", false);
      show("copy-invoice", false);
      show("reserve-hint", false);
      setMsg("receive-msg", "The node isn't running — start it from the menu first.", "err");
      return;
    }
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

  syncAmountField();
  registerScreen("screen-receive", { onShow: () => void onShow() });
}
