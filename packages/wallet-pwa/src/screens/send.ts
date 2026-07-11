import type { AppContext } from "../core/app-context";
import { classifySendInput } from "../core/send-input";
import { guardedClick } from "../core/ui-helpers";
import { registerScreen } from "../ui/nav";
import { $, show, setMsg, fmtSats } from "./util";

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

  function syncInputKind(): void {
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
      setMsg("send-msg", `Paid ${fmtSats(res.amountSats)} sats ✓`, "ok");
      input.value = "";
      syncInputKind();
    } catch (e) {
      if (isPaymentTimeout(e)) {
        // The payment left the node and hasn't settled yet — pending, NOT failed. Retrying
        // now could double-pay; the transactions sheet shows the final outcome.
        setMsg("send-msg", "Payment is still in flight — check Transactions in a moment before retrying.", "err");
        return;
      }
      setMsg("send-msg", (e as Error).message, "err");
    }
  });

  registerScreen("screen-send", {
    onShow: () => {
      setMsg("send-msg", "");
      syncInputKind();
    },
  });
}
