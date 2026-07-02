import type { LibreListenerWallet } from "@libre/listener-wallet";
import { bytesToHex } from "@libre/listener-wallet";
import {
  Event,
  Event_PaymentSent,
  Event_PaymentFailed,
  Option_ThirtyTwoBytesZ_Some,
} from "lightningdevkit";

// Awaits outbound-payment settlement by payment hash, resolving with the preimage on
// Event_PaymentSent and rejecting on Event_PaymentFailed. This mirrors the pendingPayments
// machinery inside NwcManager, but lives in the extension so WebLN sendPayment/keysend can
// return a preimage synchronously. Register the waiter BEFORE initiating the payment (compute
// the hash from a self-generated preimage for keysend) so there is no race with the event.
export class PaymentTracker {
  private waiters: Map<string, { resolve: (preimage: string) => void; reject: (err: Error) => void }> = new Map();

  constructor(wallet: LibreListenerWallet) {
    // LDK event dispatch MUST use instanceof (minification mangles constructor.name) — same
    // rule the SDK follows in handle_event.
    wallet.addEventListener((event: Event) => {
      if (event instanceof Event_PaymentSent) {
        this.settle(bytesToHex(event.payment_hash), bytesToHex(event.payment_preimage));
      } else if (event instanceof Event_PaymentFailed) {
        if (event.payment_hash instanceof Option_ThirtyTwoBytesZ_Some) {
          this.fail(bytesToHex(event.payment_hash.some), "LDK payment execution failed");
        }
      }
    });
  }

  // Await settlement for a hash. `ms` caps the wait — a late settlement after the timeout is
  // still a real payment, but the caller stops blocking on it.
  waitForSettlement(paymentHashHex: string, ms: number): Promise<string> {
    const settled = new Promise<string>((resolve, reject) => {
      this.waiters.set(paymentHashHex, { resolve, reject });
    });
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<string>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Payment initiated but not yet settled; it may still complete.")),
        ms
      );
    });
    return Promise.race([settled, timeout]).finally(() => {
      clearTimeout(timer!);
      this.waiters.delete(paymentHashHex);
    });
  }

  private settle(hashHex: string, preimageHex: string): void {
    const w = this.waiters.get(hashHex);
    if (w) {
      this.waiters.delete(hashHex);
      w.resolve(preimageHex);
    }
  }

  private fail(hashHex: string, msg: string): void {
    const w = this.waiters.get(hashHex);
    if (w) {
      this.waiters.delete(hashHex);
      w.reject(new Error(msg));
    }
  }
}
