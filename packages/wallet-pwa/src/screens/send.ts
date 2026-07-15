import type { AppContext } from "../core/app-context";
import { classifySendInput } from "@libre/wallet-core";
import { isDemoMode } from "../core/demo-mode";
import { sendResultView, type SendResultKind } from "../core/send-result";
import { guardedClick } from "../core/ui-helpers";
import { registerScreen, resetToHome } from "../ui/nav";
import { $, show, setMsg } from "./util";

// Paste-only send: BOLT11 invoice or Lightning Address. QR scanning is a deferred follow-up.
// Fund-safety: a PAYMENT_TIMEOUT after dispatch means IN FLIGHT — shown as pending, never
// failed, and never blind-retried (the SDK's PaymentTimeoutError contract).

function isPaymentTimeout(e: unknown): boolean {
  return (e as { code?: string })?.code === "PAYMENT_TIMEOUT" || /PAYMENT_TIMEOUT/.test((e as Error)?.message ?? "");
}

export function initSendScreen(ctx: AppContext): void {
  const controller = ctx.controller;
  const input = $<HTMLTextAreaElement>("send-input");
  const amountRow = $("send-amount-row");

  // Full-cover confirmation shown after a send so a settled/in-flight payment is unmissable
  // (the old inline "Paid ✓" line cleared with the form and read as "nothing happened").
  function showResult(kind: SendResultKind, amountSats?: number): void {
    const v = sendResultView(kind, amountSats);
    const cover = $("send-result");
    cover.classList.toggle("warn", v.tone === "warn");
    $("send-result-amount").textContent = v.amountText;
    $("send-result-title").textContent = v.title;
    $("send-result-note").textContent = v.note;
    show(cover, true);
  }

  function hideResult(): void {
    show("send-result", false);
    $("send-result").classList.remove("warn");
  }

  // Done returns home (form is already reset), where the updated balance + Transactions live.
  $("send-result-done").addEventListener("click", () => {
    hideResult();
    resetToHome();
  });

  function syncInputKind(): void {
    // Demo accepts anything — no real invoice/address required; the amount field always shows.
    if (isDemoMode()) {
      show(amountRow, true);
      setMsg("send-msg", "");
      return;
    }
    const kind = classifySendInput(input.value).kind;
    // A Lightning Address needs an amount; a BOLT11 invoice carries its own.
    show(amountRow, kind === "lnaddress");
    if (kind === "invalid" && input.value.trim().length > 8) {
      setMsg("send-msg", "That doesn't look like an invoice or Lightning Address yet.");
    } else {
      setMsg("send-msg", "");
    }
  }
  input.addEventListener("input", syncInputKind);

  guardedClick($<HTMLButtonElement>("send-pay"), async () => {
    if (isDemoMode()) {
      const raw = input.value.trim();
      if (!raw) {
        setMsg("send-msg", "Type anything — demo payments always go through.", "err");
        return;
      }
      const amt = parseInt($<HTMLInputElement>("send-amount").value.replace(/\D/g, "") || "0", 10) || 100;
      setMsg("send-msg", "Sending…");
      const res = await controller.payLightning(raw, { amountSats: amt });
      input.value = "";
      setMsg("send-msg", "");
      showResult("sent", res.amountSats);
      return;
    }
    const classified = classifySendInput(input.value);
    if (classified.kind === "invalid") {
      setMsg("send-msg", "Enter a BOLT11 invoice (lnbc…) or Lightning Address (name@domain).", "err");
      return;
    }
    let amountSats: number | undefined;
    if (classified.kind === "lnaddress") {
      amountSats = parseInt($<HTMLInputElement>("send-amount").value.replace(/\D/g, "") || "0", 10);
      if (!amountSats) {
        setMsg("send-msg", "Enter an amount in sats for a Lightning Address payment.", "err");
        return;
      }
    }
    setMsg("send-msg", "Sending…");
    try {
      const res = await controller.payLightning(input.value, { amountSats });
      input.value = "";
      setMsg("send-msg", "");
      syncInputKind();
      showResult("sent", res.amountSats);
    } catch (e) {
      if (isPaymentTimeout(e)) {
        // The payment left the node and hasn't settled yet — pending, NOT failed. Retrying
        // now could double-pay; the transactions sheet shows the final outcome.
        input.value = "";
        setMsg("send-msg", "");
        showResult("pending", amountSats);
        return;
      }
      setMsg("send-msg", (e as Error).message, "err");
    }
  });

  registerScreen("screen-send", {
    onShow: () => {
      hideResult(); // a re-entry starts clean (e.g. Send again after a prior confirmation)
      setMsg("send-msg", "");
      syncInputKind();
    },
  });
}
