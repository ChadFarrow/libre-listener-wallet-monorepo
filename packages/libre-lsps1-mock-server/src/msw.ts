// MSW handlers backed by the SAME MockLsps1Provider core the standalone server uses, so a vitest
// suite drives LibreListenerWallet.purchaseLSPS1Capacity / getLSPS1Order against a faithful LSPS1
// REST provider with no socket and no docker. Import into a test's setupServer(...) or server.use(...).
//
// `baseUrl` must equal the LspProvider.api_url the wallet is given (e.g. "http://mock-lsp.test/lsps1").
import { http, HttpResponse } from "msw";
import { MockLsps1Provider, MockLspError } from "./mock-provider";
import { routeMockLsps1 } from "./http-router";

export function mockLsps1MswHandlers(baseUrl: string, provider: MockLsps1Provider) {
  const base = baseUrl.replace(/\/$/, "");

  const dispatch = async (method: string, request: Request, url: URL) => {
    let body: unknown;
    if (method === "POST") {
      body = await request.clone().json().catch(() => undefined);
    }
    try {
      // Path relative to base ("" → "/") so routeMockLsps1 sees "/get_info" etc.
      const rel = url.pathname.replace(base.replace(/^https?:\/\/[^/]+/, ""), "") || "/";
      const result = routeMockLsps1(provider, method, rel, url.searchParams, body);
      return HttpResponse.json(result.body as object, { status: result.status });
    } catch (e) {
      if (e instanceof MockLspError) return HttpResponse.json({ error: e.message }, { status: e.status });
      throw e;
    }
  };

  return [
    http.get(`${base}/get_info`, ({ request }) => dispatch("GET", request, new URL(request.url))),
    http.post(`${base}/create_order`, ({ request }) => dispatch("POST", request, new URL(request.url))),
    http.get(`${base}/get_order`, ({ request }) => dispatch("GET", request, new URL(request.url))),
  ];
}
