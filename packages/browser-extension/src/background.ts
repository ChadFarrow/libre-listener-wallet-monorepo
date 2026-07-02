import { MSG, newId, type RpcResponse } from "./core/messages";
import { PermissionStore } from "./core/permission-store";
import { chromeKV } from "./core/chrome-kv";
import { normalizeSendPayment, spendAmountSats } from "./core/webln-mapping";
import { invoiceAmountSats } from "./core/bolt11-amount";

// The background service worker is a THIN, restartable router + permission gate. It never hosts
// the node (that's the offscreen document) — it can be killed at ~30s idle and respawn without
// losing wallet state. Two jobs:
//   1. Ensure the offscreen document exists and relay RPC to it.
//   2. Gate WebLN requests from pages: per-origin enable() approval + spending caps.

const store = new PermissionStore(chromeKV);

// ---- Offscreen lifecycle (idempotent) ----

let creating: Promise<unknown> | null = null;
async function ensureOffscreen(): Promise<void> {
  // @ts-ignore hasDocument exists in Chrome 116+
  if (await chrome.offscreen.hasDocument?.()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: "Runs the Lightning (LDK) node: WASM, the WebSocket peer connection, and background sync timers.",
      })
      .catch((e: unknown) => {
        // A concurrent caller may have created it first.
        if (!String(e).includes("single offscreen")) throw e;
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

async function callOffscreen(method: string, params?: any): Promise<any> {
  await ensureOffscreen();
  const id = newId();
  const resp: RpcResponse = await chrome.runtime.sendMessage({ kind: MSG.WALLET_RPC, id, method, params });
  if (!resp) throw new Error("No response from wallet host");
  if (!resp.ok) throw new Error(resp.error || "Wallet host error");
  return resp.result;
}

// ---- Approval prompts ----

interface PendingApproval {
  resolve: (d: { approved: boolean; spendingLimitSats: number }) => void;
  windowId?: number;
}
const pendingApprovals = new Map<string, PendingApproval>();

async function requestApproval(origin: string): Promise<{ approved: boolean; spendingLimitSats: number }> {
  const id = newId();
  const url = chrome.runtime.getURL(`approval.html?origin=${encodeURIComponent(origin)}&id=${id}`);
  const decision = new Promise<{ approved: boolean; spendingLimitSats: number }>((resolve) => {
    pendingApprovals.set(id, { resolve });
  });
  const win = await chrome.windows.create({ url, type: "popup", width: 400, height: 560, focused: true });
  const p = pendingApprovals.get(id);
  if (p) p.windowId = win?.id;
  return decision;
}

// A closed approval window with no decision counts as a denial.
chrome.windows.onRemoved.addListener((closedId) => {
  for (const [id, p] of pendingApprovals) {
    if (p.windowId === closedId) {
      pendingApprovals.delete(id);
      p.resolve({ approved: false, spendingLimitSats: 0 });
    }
  }
});

async function ensureEnabled(origin: string): Promise<void> {
  if (await store.isEnabled(origin)) return;
  const decision = await requestApproval(origin);
  if (!decision.approved) throw new Error(`User denied wallet access for ${origin}`);
  await store.grant(origin, { spendingLimitSats: decision.spendingLimitSats });
}

// ---- WebLN permission gate ----

async function handleWebln(origin: string, method: string, params: any): Promise<any> {
  if (method === "enable") {
    await ensureEnabled(origin);
    return {};
  }
  if (method === "isEnabled") {
    return await store.isEnabled(origin);
  }
  if (!(await store.isEnabled(origin))) {
    throw new Error("Wallet access not granted for this site. Call webln.enable() first.");
  }

  if (method === "sendPayment") {
    // Decode the invoice amount for the cap check (background has no LDK). Authoritative payment
    // happens in the offscreen host.
    const bolt11 = normalizeSendPayment(params);
    const amt = safeInvoiceAmount(bolt11);
    if (amt != null) await store.chargeIfWithinCap(origin, amt);
    try {
      return await callOffscreen("sendPayment", params);
    } catch (e) {
      if (amt != null) await store.refund(origin, amt);
      throw e;
    }
  }

  if (method === "keysend") {
    const amt = spendAmountSats("keysend", params);
    await store.chargeIfWithinCap(origin, amt);
    try {
      return await callOffscreen("keysend", params);
    } catch (e) {
      await store.refund(origin, amt);
      throw e;
    }
  }

  // Read-only after enable: getInfo, makeInvoice.
  return await callOffscreen(method, params);
}

function safeInvoiceAmount(bolt11: string): number | null {
  try {
    return invoiceAmountSats(bolt11);
  } catch {
    // Let the offscreen host reject a malformed invoice; skip the cap pre-check.
    return null;
  }
}

// ---- Router ----

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const reply = (p: Promise<any>) =>
    void p.then(
      (result) => sendResponse({ id: msg?.id, ok: true, result } as RpcResponse),
      (err) => sendResponse({ id: msg?.id, ok: false, error: err?.message || String(err) } as RpcResponse)
    );

  switch (msg?.kind) {
    case MSG.WEBLN_REQUEST:
      // Origin is stamped by the content-script (trusted), never taken from the page.
      reply(handleWebln(msg.origin, msg.method, msg.params));
      return true;

    case MSG.WALLET_COMMAND:
      // Trusted control-plane from popup/options. Permission commands are owned by the background
      // (the permission store lives here); everything else forwards to the offscreen host.
      if (msg.command === "listGrants") {
        reply(store.listGrants());
      } else if (msg.command === "revokeGrant") {
        reply(store.revoke(msg.params.origin));
      } else if (msg.command === "setGrantLimit") {
        reply(store.grant(msg.params.origin, { spendingLimitSats: Number(msg.params.spendingLimitSats) || 0 }));
      } else {
        reply(callOffscreen(msg.command, msg.params));
      }
      return true;

    case MSG.APPROVAL_DECISION: {
      const p = pendingApprovals.get(msg.id);
      if (p) {
        pendingApprovals.delete(msg.id);
        p.resolve({ approved: !!msg.approved, spendingLimitSats: Number(msg.spendingLimitSats) || 0 });
      }
      sendResponse({ id: msg.id, ok: true } as RpcResponse);
      return true;
    }

    default:
      return false; // not ours (e.g. WALLET_RPC handled by offscreen, WALLET_EVENT by popup)
  }
});
