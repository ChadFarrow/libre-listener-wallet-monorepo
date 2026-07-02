// The window.postMessage protocol between the injected page provider (inpage.js, main world)
// and the content-script (isolated world). Deliberately tiny and tagged so we ignore unrelated
// page messages. The content-script — NOT the page — is the trust boundary: it stamps the real
// page origin from its own location, so a page cannot forge which origin a request comes from.

export const WEBLN_MSG_SOURCE = "libre-webln";

export interface InpageRequest {
  source: typeof WEBLN_MSG_SOURCE;
  direction: "request";
  id: string;
  method: string;
  params?: any;
}

export interface InpageResponse {
  source: typeof WEBLN_MSG_SOURCE;
  direction: "response";
  id: string;
  ok: boolean;
  result?: any;
  error?: string;
}
