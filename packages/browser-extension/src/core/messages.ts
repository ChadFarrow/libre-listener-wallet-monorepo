// The message contract that ties the extension contexts together.
//
//   page (inpage window.webln)  --window.postMessage-->  content-script
//   content-script              --chrome.runtime------->  background (router + permission gate)
//   background                  --chrome.runtime------->  offscreen (wallet host)
//   popup / options             --chrome.runtime------->  background --> offscreen
//
// Two message families:
//   - WeblnRequest: originates in a page, carries the page origin (stamped by the
//     content-script — the page cannot forge it), and is subject to the permission gate.
//   - WalletCommand: originates in the extension's own UI (popup/options), fully trusted,
//     drives wallet lifecycle + setup. Never reachable from a page.

// The WebLN method lists live in @libre/wallet-core (shared with the embeddable widget's
// in-page gate); re-exported here so extension consumers keep importing them from messages.
export { WEBLN_METHODS, WEBLN_SPENDING_METHODS, type WeblnMethod } from "@libre/wallet-core";
import type { WeblnMethod } from "@libre/wallet-core";

// Namespaced message "kinds" so a single chrome.runtime.onMessage handler can fan out.
export const MSG = {
  // page → content-script → background
  WEBLN_REQUEST: "libre:webln-request",
  // background → offscreen (internal wallet RPC)
  WALLET_RPC: "libre:wallet-rpc",
  // popup/options → background (trusted control-plane)
  WALLET_COMMAND: "libre:wallet-command",
  // offscreen/background → any listener (state pushes)
  WALLET_EVENT: "libre:wallet-event",
  // background → popup (open an approval prompt for an origin)
  APPROVAL_DECISION: "libre:approval-decision",
} as const;

export interface WeblnRequestMessage {
  kind: typeof MSG.WEBLN_REQUEST;
  id: string;
  origin: string; // stamped by the content-script, authoritative
  method: WeblnMethod;
  params?: any;
}

export interface WalletRpcMessage {
  kind: typeof MSG.WALLET_RPC;
  id: string;
  method: string;
  params?: any;
}

export interface WalletCommandMessage {
  kind: typeof MSG.WALLET_COMMAND;
  id: string;
  command: string;
  params?: any;
}

export interface RpcResponse<T = any> {
  id: string;
  ok: boolean;
  result?: T;
  error?: string;
}

export interface WalletEventMessage {
  kind: typeof MSG.WALLET_EVENT;
  event: string; // "state-changed" | "status" | "log" | ...
  payload?: any;
}

export function newId(): string {
  // Non-crypto id, only used to correlate request/response pairs.
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return `${a[0].toString(36)}${a[1].toString(36)}`;
}
