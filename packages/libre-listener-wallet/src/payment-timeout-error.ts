// Thrown by payBolt11 when a payment was successfully handed to LDK but did not settle within
// the wait window. The payment is IN FLIGHT — callers must present it as pending (check history),
// never as failed, and must not blind-retry (fund-safety: a retry could double-pay). Code is
// mirrored in the message so it survives boundary error-flattening.
export class PaymentTimeoutError extends Error {
  readonly code = "PAYMENT_TIMEOUT";
  constructor(readonly paymentHash: string) {
    super(
      `[PAYMENT_TIMEOUT] Payment is still in flight — it was sent but has not settled yet. ` +
        `Check the payment history before retrying.`,
    );
    this.name = "PaymentTimeoutError";
  }
}
