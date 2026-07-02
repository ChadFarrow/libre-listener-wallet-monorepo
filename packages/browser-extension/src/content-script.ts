import { MSG, type RpcResponse } from "./core/messages";
import { WEBLN_MSG_SOURCE, type InpageRequest, type InpageResponse } from "./core/inpage-protocol";

// Runs in the page's ISOLATED world at document_start. Two jobs:
//   1. Inject inpage.js into the page's MAIN world so `window.webln` is a real page global (a
//      content-script closure wouldn't be visible to the page).
//   2. Relay page WebLN requests to the background, stamping the AUTHORITATIVE page origin (read
//      from our own location, never from the message) so the permission gate can trust it.
// The content-script cannot touch the extension's IndexedDB / wallet state — all of that is
// reached only through the background → offscreen path.

// 1. Inject the provider into the main world.
(function injectProvider() {
  try {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("inpage.js");
    script.async = false;
    (document.head || document.documentElement).appendChild(script);
    script.remove(); // executes synchronously; tag no longer needed
  } catch (e) {
    console.error("[Libre] Failed to inject WebLN provider:", e);
  }
})();

// 2. Relay page → background → page.
const pageOrigin = window.location.origin;

window.addEventListener("message", (event: MessageEvent) => {
  // Only accept messages this window posted to itself, tagged as our requests.
  if (event.source !== window) return;
  const data = event.data as InpageRequest;
  if (!data || data.source !== WEBLN_MSG_SOURCE || data.direction !== "request") return;

  const respond = (partial: Omit<InpageResponse, "source" | "direction" | "id">) => {
    const response: InpageResponse = {
      source: WEBLN_MSG_SOURCE,
      direction: "response",
      id: data.id,
      ...partial,
    };
    window.postMessage(response, pageOrigin);
  };

  chrome.runtime
    .sendMessage({
      kind: MSG.WEBLN_REQUEST,
      id: data.id,
      origin: pageOrigin, // trusted: our own origin, not from the page message
      method: data.method,
      params: data.params,
    })
    .then(
      (resp: RpcResponse) => respond({ ok: !!resp?.ok, result: resp?.result, error: resp?.error }),
      (err: Error) => respond({ ok: false, error: err?.message || String(err) })
    );
});
