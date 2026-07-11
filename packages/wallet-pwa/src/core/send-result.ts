// The post-send confirmation state. A plain inline "Paid ✓" text line under the Pay button was
// too easy to miss on a large dark screen (users read the cleared form as "nothing happened"), so
// a send now shows a full-cover success/pending state with a Done button. Pure + testable; the
// screen maps this to the DOM. `pending` = the SDK's PAYMENT_TIMEOUT (IN FLIGHT, not failed —
// never render it as a failure, never blind-retry → double-pay).

export type SendResultKind = "sent" | "pending";

export interface SendResultView {
  kind: SendResultKind;
  title: string;
  amountText: string; // "" when the amount isn't known (a timeout can precede the settled amount)
  note: string;
  tone: "ok" | "warn";
}

export function sendResultView(kind: SendResultKind, amountSats?: number): SendResultView {
  const amountText =
    typeof amountSats === "number" && Number.isFinite(amountSats) && amountSats > 0
      ? `${Math.round(amountSats).toLocaleString("en-US")} sats`
      : "";
  if (kind === "pending") {
    return {
      kind,
      title: "Payment in flight",
      amountText,
      note: "It left your wallet and is still settling. Check Transactions in a moment — don't resend, or you may pay twice.",
      tone: "warn",
    };
  }
  return {
    kind,
    title: "Payment sent",
    amountText,
    note: "Your payment settled successfully.",
    tone: "ok",
  };
}
