import { WEBLN_MSG_SOURCE, type InpageRequest, type InpageResponse } from "../core/inpage-protocol";

// Injected into the page's MAIN world. Defines the standard WebLN provider on window.webln so
// any app — including UIs like Bitcoin Connect that detect window.webln — can drive the wallet
// with zero per-app integration. This file is thin: it forwards each call to the content-script
// (which relays to the background permission gate + offscreen node) and awaits the reply. No
// wallet logic, no secrets, no chrome APIs live here.

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };
const pending = new Map<string, Pending>();

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as InpageResponse;
  if (!data || data.source !== WEBLN_MSG_SOURCE || data.direction !== "response") return;
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  if (data.ok) p.resolve(data.result);
  else p.reject(new Error(data.error || "WebLN request failed"));
});

function rpc(method: string, params?: any): Promise<any> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const req: InpageRequest = { source: WEBLN_MSG_SOURCE, direction: "request", id, method, params };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.postMessage(req, window.location.origin);
  });
}

class LibreWebLNProvider {
  // Standard WebLN surface. `enabled` flips true after a successful enable() and lets apps that
  // read the property (e.g. Bitcoin Connect) skip re-prompting.
  enabled = false;
  readonly isEnabled = false; // overwritten below via getter for spec-compatibility

  async enable(): Promise<void> {
    await rpc("enable");
    this.enabled = true;
  }

  async getInfo(): Promise<any> {
    return rpc("getInfo");
  }

  async makeInvoice(args: any): Promise<{ paymentRequest: string }> {
    return rpc("makeInvoice", args);
  }

  async sendPayment(paymentRequest: string): Promise<{ preimage: string }> {
    return rpc("sendPayment", paymentRequest);
  }

  async keysend(args: any): Promise<{ preimage: string }> {
    return rpc("keysend", args);
  }
}

// Politely avoid clobbering another WebLN provider (e.g. Alby) if one is already present.
const existing = (window as any).webln;
if (existing) {
  console.warn("[Libre] A window.webln provider is already present; Libre WebLN not injected.");
} else {
  const provider = new LibreWebLNProvider();
  // isEnabled as a live getter mirroring `enabled`.
  Object.defineProperty(provider, "isEnabled", { get: () => provider.enabled });
  Object.defineProperty(window, "webln", { value: provider, configurable: true, writable: false });
  // Announce for listeners that wait for late injection.
  window.dispatchEvent(new Event("webln:ready"));
}
