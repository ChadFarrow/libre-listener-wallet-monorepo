// The trust boundary between an untrusted page and the privileged offscreen wallet host.
//
// A page can only ever reach the WebLN provider surface. Everything else the offscreen host
// dispatches (createWallet, exportBackup, restoreWallet, setConfig, nwcCreateConnection, …) is
// control-plane, reachable ONLY from the extension's own UI via WALLET_COMMAND. The background
// gate MUST NOT forward an arbitrary page-supplied method string to the offscreen host — doing so
// lets an enabled origin mint an unlimited NWC pairing, exfiltrate the (encrypted) seed envelope,
// or read the raw seed out of createWallet. This allowlist is that boundary.

import { WEBLN_METHODS } from "./webln-methods";

const ALLOWED = new Set<string>(WEBLN_METHODS);

// True only for the WebLN methods a page is permitted to invoke. Exact match — no trimming or
// case-folding, so a page cannot smuggle a control-plane method past the gate.
export function isAllowedWeblnMethod(method: string): boolean {
  return typeof method === "string" && ALLOWED.has(method);
}
