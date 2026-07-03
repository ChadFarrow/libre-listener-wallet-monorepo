import type { LibreListenerWallet } from "@libre/listener-wallet";
import { bytesToHex } from "@libre/listener-wallet";
import {
  Bolt11Invoice,
  UtilMethods,
  Option_u64Z_Some,
  Retry,
  Result_C3Tuple_ThirtyTwoBytesRecipientOnionFieldsRouteParametersZNoneZ_OK,
} from "lightningdevkit";
import type { PaymentTracker } from "./payment-tracker";

const SETTLEMENT_TIMEOUT_MS = 90_000;

// Pay a BOLT11 invoice through the LDK ChannelManager, mirroring NwcManager's pay_invoice path
// (the wallet has no public payInvoice, so this ports the same minimal LDK plumbing). Registers
// the settlement waiter before send_payment so there's no race with Event_PaymentSent. Returns
// the preimage. Only amount-carrying invoices are supported (matches NWC).
export async function payBolt11(
  wallet: LibreListenerWallet,
  tracker: PaymentTracker,
  bolt11: string
): Promise<{ preimage: string; amountSats: number }> {
  const mgr = wallet.getChannelManager();
  if (!mgr) throw new Error("Wallet not started");

  const invoiceRes = Bolt11Invoice.constructor_from_str(bolt11);
  if (!invoiceRes.is_ok()) throw new Error("Invalid BOLT11 invoice");
  const invoice = (invoiceRes as any).res;

  const amtOpt = invoice.amount_milli_satoshis();
  if (!(amtOpt instanceof Option_u64Z_Some)) {
    throw new Error("Zero-amount invoices are not supported");
  }
  const amountSats = Number(amtOpt.some / 1000n);

  const paramRes = UtilMethods.constructor_payment_parameters_from_invoice(invoice);
  if (!paramRes.is_ok()) throw new Error("Failed to construct payment parameters from invoice");
  const tuple = (paramRes as Result_C3Tuple_ThirtyTwoBytesRecipientOnionFieldsRouteParametersZNoneZ_OK).res;
  const paymentHash = tuple.get_a();
  const onionFields = tuple.get_b();
  const routeParams = tuple.get_c();

  const hashHex = bytesToHex(paymentHash);
  const settled = tracker.waitForSettlement(hashHex, SETTLEMENT_TIMEOUT_MS);

  const paymentId = crypto.getRandomValues(new Uint8Array(32));
  const sendRes = mgr.send_payment(paymentHash, onionFields, paymentId, routeParams, Retry.constructor_attempts(10));
  if (!sendRes.is_ok()) {
    throw new Error(`send_payment failed: ${(sendRes as any).err?.toString() || "route not found"}`);
  }

  const preimage = await settled;
  return { preimage, amountSats };
}
