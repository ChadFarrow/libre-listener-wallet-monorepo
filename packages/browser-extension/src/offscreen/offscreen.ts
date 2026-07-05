import { WalletHost } from "./wallet-host";
import { handleWeblnRequest } from "../core/webln-mapping";
import { MSG, type RpcResponse } from "../core/messages";
import { isFromExtensionContext } from "../core/sender-guard";

// The offscreen document is the ONLY long-lived context that hosts the LDK node (WASM +
// WebSocket + timers). The background service worker is killed after ~30s idle, which would
// tear down LDK's sync/peer/gossip timers and abort in-flight payments — so the node lives here
// and the background stays a thin router. This document has a real DOM (needed for WASM in some
// builds) but no visible UI.

const host = new WalletHost((event, payload) => {
  // Broadcast state pushes so the popup can live-update. Fire-and-forget; ignore "no receiver".
  chrome.runtime.sendMessage({ kind: MSG.WALLET_EVENT, event, payload }).catch(() => {});
});

// Internal RPC surface. `method` is either a WebLN method (getInfo/makeInvoice/sendPayment/
// keysend) forwarded from a page after the permission gate, or a trusted control-plane command
// from the popup/options. Both arrive as MSG.WALLET_RPC — the background is responsible for only
// forwarding WebLN methods that passed the gate.
async function dispatch(method: string, params: any): Promise<any> {
  switch (method) {
    // WebLN-facing (post-permission)
    case "getInfo":
    case "makeInvoice":
    case "sendPayment":
    case "keysend":
      return handleWeblnRequest(host, method, params);

    // Control-plane (popup/options)
    case "getState":
      return host.getState();
    case "getConfig":
      return host.getConfig();
    case "setConfig":
      return host.setConfig(params ?? {});
    case "createWallet":
      return host.createWallet(params ?? {});
    case "restoreWallet":
      return host.restoreWallet(params.envelope, params.secret);
    case "startNode":
      return host.startNode();
    case "autoStart":
      // Fired by the background right after it creates this document (every creation path goes
      // through its ensureOffscreen). The background reads the auto_start flag and passes it in —
      // chrome.storage is undefined in offscreen documents, so this context can't read it itself.
      return host.autoStart(params?.flagRaw ?? null);
    case "stopNode":
      return host.stopNode();
    case "resetWallet":
      return host.resetWallet();
    case "exportBackup":
      return host.exportBackup();
    case "getRecoveryPhrase":
      return host.getRecoveryPhrase();
    case "exportBackupBlob":
      return host.exportBackupBlob();
    case "getSweepAddress":
      return host.getSweepAddress();
    case "setSweepAddress":
      return host.setSweepAddress(params?.address ?? "");
    case "connectPeer":
      return host.connectPeer(params.pubkey, params.host, params.port);
    case "syncGossip":
      return host.syncGossip();
    case "purchaseLSPS1Capacity":
      return host.purchaseLSPS1Capacity(params ?? {});
    case "getLSPS1Order":
      return host.getLSPS1Order(params.apiUrl, params.orderId);
    case "getBalance":
      return host.getBalanceSats();
    case "createInvoice":
      return host.createInvoice(params.amountSats, params.memo, params.expirySeconds);
    case "nwcCreateConnection":
      return host.nwcCreateConnection(params.name, params);
    case "nwcListConnections":
      return host.nwcListConnections();
    case "nwcDeleteConnection":
      return host.nwcDeleteConnection(params.clientPubkey);
    default:
      throw new Error(`Unknown wallet RPC method: ${method}`);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.kind !== MSG.WALLET_RPC) return; // not ours
  // Only the extension's own contexts (the background router) may drive the privileged wallet RPC.
  // A content script — whose url is the web page, not chrome-extension:// — must never reach the
  // dispatcher directly, or it would bypass the background's WebLN permission gate.
  if (!isFromExtensionContext(sender, chrome.runtime.id, chrome.runtime.getURL(""))) {
    sendResponse({ id: msg.id, ok: false, error: "Unauthorized wallet RPC sender" } satisfies RpcResponse);
    return true;
  }
  void dispatch(msg.method, msg.params).then(
    (result) => sendResponse({ id: msg.id, ok: true, result } satisfies RpcResponse),
    (err) => sendResponse({ id: msg.id, ok: false, error: err?.message || String(err) } satisfies RpcResponse)
  );
  return true; // async response
});

