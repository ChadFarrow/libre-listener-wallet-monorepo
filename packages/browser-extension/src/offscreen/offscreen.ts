import { WalletHost } from "./wallet-host";
import { handleWeblnRequest } from "../core/webln-mapping";
import { MSG, type RpcResponse } from "../core/messages";

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
    case "stopNode":
      return host.stopNode();
    case "exportBackup":
      return host.exportBackup();
    case "connectPeer":
      return host.connectPeer(params.pubkey, params.host, params.port);
    case "syncGossip":
      return host.syncGossip();
    case "getBalance":
      return host.getBalanceSats();
    default:
      throw new Error(`Unknown wallet RPC method: ${method}`);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind !== MSG.WALLET_RPC) return; // not ours
  void dispatch(msg.method, msg.params).then(
    (result) => sendResponse({ id: msg.id, ok: true, result } satisfies RpcResponse),
    (err) => sendResponse({ id: msg.id, ok: false, error: err?.message || String(err) } satisfies RpcResponse)
  );
  return true; // async response
});
