// The WebLN provider the host page gets from mountLibreWallet(). Reuses the portable WebLN layer
// from @libre/wallet-core: the method allowlist (webln-gate), the WebLN→WalletRpc mapping
// (webln-mapping), and the per-origin daily spending caps (permission-store). The trust model
// differs from the extension: here the host page and the wallet share one JS context, so the gate
// + caps protect against host-app BUGS (a runaway boost loop), not a hostile page — see README.
// Spend approvals surface through the injected requestApproval (the widget's in-shadow modal).

import {
  PermissionStore,
  QuotaExceededError,
  WeblnError,
  handleWeblnRequest,
  invoiceAmountSats,
  isAllowedWeblnMethod,
  normalizeKeysend,
  normalizeSendPayment,
  type KVStore,
  type WalletRpc,
} from "@libre/wallet-core";
import { errorMatchesCode } from "@libre/shared";

export interface ApprovalRequest {
  kind: "enable" | "raise-cap";
  origin: string;
  /** For raise-cap: the spend that tripped the cap. */
  amountSats?: number;
  currentLimitSats?: number | null;
}

/** Resolved by the widget's approval modal. `limitSats: null` = unlimited (explicit checkbox). */
export type ApprovalDecision = { granted: false } | { granted: true; limitSats: number | null };

export interface WeblnProviderDeps {
  rpc: WalletRpc;
  origin: string;
  kv: KVStore;
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>;
  /** True while the wallet is running here — spends are refused while draining/moved. */
  isActive(): boolean;
  now?: () => number;
}

export interface LibreWeblnProvider {
  enable(): Promise<void>;
  isEnabled: boolean;
  getInfo(): Promise<unknown>;
  makeInvoice(args: unknown): Promise<{ paymentRequest: string }>;
  sendPayment(paymentRequest: string): Promise<{ preimage: string }>;
  keysend(args: unknown): Promise<{ preimage: string }>;
}

export function createWeblnProvider(deps: WeblnProviderDeps): LibreWeblnProvider {
  const store = new PermissionStore(deps.kv, deps.now ?? (() => Date.now()));
  let enabled = false;

  async function ensureEnabled(): Promise<void> {
    if (enabled || (await store.isEnabled(deps.origin))) {
      enabled = true;
      return;
    }
    const decision = await deps.requestApproval({ kind: "enable", origin: deps.origin });
    if (!decision.granted) throw new WeblnError("User rejected the connection request");
    await store.grant(deps.origin, { spendingLimitSats: decision.limitSats ?? 0 }); // 0 = unlimited (store convention)
    enabled = true;
  }

  function ensureActive(): void {
    if (!deps.isActive()) {
      throw new WeblnError("The wallet is not active on this site right now.");
    }
  }

  // Charge the per-origin daily cap; on quota-exceeded, ask the user once to raise it, then retry.
  async function chargeCap(amountSats: number): Promise<void> {
    if (amountSats <= 0) return;
    try {
      await store.chargeIfWithinCap(deps.origin, amountSats);
      return;
    } catch (e) {
      if (!(e instanceof QuotaExceededError)) throw e;
    }
    const grant = await store.getGrant(deps.origin);
    const decision = await deps.requestApproval({
      kind: "raise-cap",
      origin: deps.origin,
      amountSats,
      currentLimitSats: grant?.spendingLimitSats ?? null,
    });
    if (!decision.granted) throw new WeblnError("Payment exceeds the daily spending limit");
    await store.grant(deps.origin, { spendingLimitSats: decision.limitSats ?? 0 }); // 0 = unlimited (store convention)
    await store.chargeIfWithinCap(deps.origin, amountSats); // throws again if still over — correct
  }

  async function guarded(method: string, params: unknown): Promise<any> {
    if (!isAllowedWeblnMethod(method)) throw new WeblnError(`Method not allowed: ${method}`);
    await ensureEnabled();
    ensureActive();
    return handleWeblnRequest(deps.rpc, method, params);
  }

  return {
    get isEnabled() {
      return enabled;
    },
    async enable() {
      await ensureEnabled();
    },
    async getInfo() {
      return guarded("getInfo", undefined);
    },
    async makeInvoice(args: unknown) {
      return guarded("makeInvoice", args);
    },
    async sendPayment(paymentRequest: string) {
      if (!isAllowedWeblnMethod("sendPayment")) throw new WeblnError("Method not allowed: sendPayment");
      await ensureEnabled();
      ensureActive();
      const bolt11 = normalizeSendPayment(paymentRequest);
      // Fail closed: an invoice whose amount can't be decoded is refused rather than uncapped
      // (the extension's rule — the cap is only meaningful if every spend is counted).
      const amountSats = invoiceAmountSats(bolt11);
      if (amountSats === null || amountSats <= 0) {
        throw new WeblnError("Could not determine the invoice amount — zero-amount invoices are not supported");
      }
      await chargeCap(amountSats);
      try {
        return await handleWeblnRequest(deps.rpc, "sendPayment", paymentRequest);
      } catch (e) {
        // A PAYMENT_TIMEOUT is IN FLIGHT — the charge must stand (refunding would let a retry
        // double-spend past the cap). Every other failure is definitive → refund.
        if (!errorMatchesCode(e, "PAYMENT_TIMEOUT")) await store.refund(deps.origin, amountSats);
        throw e;
      }
    },
    async keysend(args: unknown) {
      if (!isAllowedWeblnMethod("keysend")) throw new WeblnError("Method not allowed: keysend");
      await ensureEnabled();
      ensureActive();
      const normalized = normalizeKeysend(args);
      await chargeCap(normalized.amountSats);
      try {
        return await handleWeblnRequest(deps.rpc, "keysend", args);
      } catch (e) {
        await store.refund(deps.origin, normalized.amountSats); // keysend acks on dispatch — a throw is definitive
        throw e;
      }
    },
  };
}

/** Politely install the provider as window.webln: never clobber an existing provider (Alby, the
 *  Libre extension, …), freeze against page tampering, announce via the standard ready event. */
export function installWebln(provider: LibreWeblnProvider, w: Window & { webln?: unknown } = window): boolean {
  if (w.webln) {
    console.warn("[libre-wallet] window.webln already provided — leaving the existing provider in place");
    return false;
  }
  Object.defineProperty(w, "webln", { value: provider, writable: false, configurable: true });
  w.dispatchEvent(new Event("webln:ready"));
  return true;
}
