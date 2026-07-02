import { MSG, newId, type RpcResponse, type WalletEventMessage } from "../core/messages";

// Popup/options → background control-plane call. The background ensures the offscreen host is
// alive and forwards the command to it.
export async function command<T = any>(command: string, params?: any): Promise<T> {
  const resp: RpcResponse = await chrome.runtime.sendMessage({
    kind: MSG.WALLET_COMMAND,
    id: newId(),
    command,
    params,
  });
  if (!resp) throw new Error("No response from background");
  if (!resp.ok) throw new Error(resp.error || "Command failed");
  return resp.result as T;
}

// Subscribe to state pushes broadcast by the offscreen host (node started/stopped, state advanced).
export function onWalletEvent(cb: (event: string, payload?: any) => void): void {
  chrome.runtime.onMessage.addListener((msg: WalletEventMessage) => {
    if (msg?.kind === MSG.WALLET_EVENT) cb(msg.event, msg.payload);
  });
}
